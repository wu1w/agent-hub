import { transaction } from "./transaction.ts";
import fs from "node:fs/promises";
import { isAgentPresent, supportsSessions, adapter, homedir } from "./adapters.ts";
import { loadConfig, setBind } from "./config.ts";
import {
  injectCtx,
  injectMemory,
  syncMemoryInjects,
  injectVaultCatalog,
  removeCtxInject,
  removeMemoryInject,
  removeVaultCatalog,
} from "./deliver.ts";
import { HubError } from "./errors.ts";
import { exists, isDir } from "./fsx.ts";
import {
  adoptSkills,
  detachAgentSkills,
  relinkHubSkills,
} from "./skills.ts";
import { isAgentId, isLayer, type AgentId, type HubConfig, type Layer } from "./types.ts";

export type BindInput = {
  agent: AgentId;
  layer: Layer;
  value: string;
  skillsMode?: string;
};

async function assertNotDir(dest: string, label: string): Promise<void> {
  if (await isDir(dest)) throw new HubError(`${label} 目标是目录，无法注入：${dest}`, 409);
}

export async function applyBind(input: BindInput): Promise<{ config: HubConfig; extra: unknown }> {
  return transaction(async () => {
    if (!isAgentId(input.agent) || !isLayer(input.layer)) {
      throw new HubError("invalid agent or layer", 400);
    }
    if (adapter(input.agent).memoryOnly && input.layer !== "memory") throw new HubError(`${input.agent} 本轮仅支持 Memory 自动加载`, 400);
    if (input.layer === "sessions" && input.value === "index" && !supportsSessions(input.agent)) throw new HubError(`${input.agent} 尚无会话扫描器`, 400);
    if ((input.layer === "memory" || input.layer === "ctx" || input.layer === "vault") && input.value === "hub" && !isAgentPresent(input.agent)) {
      throw new HubError(`${input.agent} 未检测到安装，请安装客户端并初始化配置后重试`, 409);
    }
    const prev = (await loadConfig()).bind[input.agent];
    const { agent, layer, value } = input;

    if (layer === "skills") {
      if (value !== "hub" && value !== "own") throw new HubError(`invalid bind ${agent}.${layer}=${value}`, 400);
      if (prev.skills === "own" && value === "hub") {
        if (input.skillsMode !== "adopt" && input.skillsMode !== "link-existing") {
          throw new HubError("skillsMode adopt|link-existing required", 400);
        }
        const extra = await adoptSkills(input.skillsMode, { only: agent, includeOwn: true, deferRelink: true });
        const config = await setBind(agent, layer, value);
        await relinkHubSkills(config);
        return { config, extra };
      }
      if (prev.skills === "hub" && value === "own") {
        const mode = input.skillsMode === "unlink" ? "unlink" : "detach-copy";
        const detached = await detachAgentSkills(agent, mode);
        const config = await setBind(agent, layer, value);
        return { config, extra: { detached } };
      }
      const config = await setBind(agent, layer, value);
      if (value === "hub") await relinkHubSkills(config);
      return { config, extra: null };
    }

    if (layer === "ctx") {
      if (value !== "hub" && value !== "own") throw new HubError(`invalid bind ${agent}.${layer}=${value}`, 400);
      if (value === "hub") {
        const ad = adapter(agent);
        if (!ad.userMdProjection || !(await loadConfig()).layers.ctx.global_targets.includes(agent)) {
          throw new HubError(`${agent} 不支持 Ctx=Hub`, 400);
        }
        const dest = ad.userMdProjection(homedir());
        await assertNotDir(dest, "ctx");
        const written = await injectCtx(agent);
        if (!written) throw new HubError("ctx inject failed", 500);
      } else {
        await removeCtxInject(agent);
      }
      return { config: await setBind(agent, layer, value), extra: null };
    }

    if (layer === "memory") {
      if (value !== "hub" && value !== "own") throw new HubError(`invalid bind ${agent}.${layer}=${value}`, 400);
      if (value === "hub") {
        const dest = adapter(agent).memoryInjectPath(homedir());
        await assertNotDir(dest, "memory");
        if (await exists(dest) && (await fs.lstat(dest)).isDirectory()) {
          throw new HubError(`memory 注入路径是目录：${dest}`, 409);
        }
        const written = await injectMemory(agent);
        if (!written) throw new HubError("memory inject failed", 500);
      } else {
        await removeMemoryInject(agent);
      }
      const config = await setBind(agent, layer, value);
      await syncMemoryInjects(undefined, { agent });
      return { config, extra: null };
    }

    if (layer === "vault") {
      if (value !== "off" && value !== "own" && value !== "hub") {
        throw new HubError(`invalid bind ${agent}.${layer}=${value}`, 400);
      }
      if (value === "hub") {
        const dest = adapter(agent).vaultCatalogPath(homedir());
        await assertNotDir(dest, "vault catalog");
        const written = await injectVaultCatalog(agent, { assumeHub: true });
        if (!written) throw new HubError("vault catalog inject failed", 500);
      } else {
        await removeVaultCatalog(agent);
      }
      return { config: await setBind(agent, layer, value), extra: null };
    }

    if (layer === "sessions") {
      if (value !== "own" && value !== "index") throw new HubError(`invalid bind ${agent}.${layer}=${value}`, 400);
      return { config: await setBind(agent, layer, value), extra: null };
    }

    throw new HubError(`invalid bind ${agent}.${layer}=${value}`, 400);
  });
}
