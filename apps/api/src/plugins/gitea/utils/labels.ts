import type { IssueWrite } from "../../sync/issue-write";
import type { GiteaConfig } from "../config";
import { createGiteaClient, type GiteaLabel } from "./gitea-api";

const labelColors: Record<string, string> = {
  "priority:low": "0EA5E9",
  "priority:medium": "EAB308",
  "priority:high": "F97316",
  "priority:urgent": "EF4444",
  "status:to-do": "6B7280",
  "status:in-progress": "3B82F6",
  "status:in-review": "8B5CF6",
  "status:done": "10B981",
  "status:planned": "8B5CF6",
  "status:archived": "6B7280",
};

function getLabelColor(labelName: string): string {
  return labelColors[labelName] || "6B7280";
}

export function labelIdsByName(labels: GiteaLabel[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const { name, id } of labels) {
    const known = ids.get(name);
    if (known === undefined || id < known) ids.set(name, id);
  }
  return ids;
}

const repositoryQueues = new Map<string, Promise<unknown>>();

function inRepositoryQueue<T>(
  config: GiteaConfig,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${config.baseUrl}|${config.repositoryOwner}/${config.repositoryName}`;
  const result = (repositoryQueues.get(key) ?? Promise.resolve()).then(
    run,
    run,
  );
  repositoryQueues.set(
    key,
    result.catch(() => {}),
  );
  return result;
}

export function ensureLabelsExistGitea(
  config: GiteaConfig,
  labels: string[],
  requireSuccess = false,
  write: IssueWrite = (send) => send(),
): Promise<Map<string, number>> {
  return inRepositoryQueue(config, () =>
    ensureLabels(config, labels, requireSuccess, write),
  );
}

async function ensureLabels(
  config: GiteaConfig,
  labels: string[],
  requireSuccess: boolean,
  write: IssueWrite,
): Promise<Map<string, number>> {
  const client = createGiteaClient(config);
  const map = new Map<string, number>();
  const { repositoryOwner, repositoryName } = config;

  let existingLabels: GiteaLabel[];
  try {
    existingLabels = await client.listLabels(repositoryOwner, repositoryName);
  } catch (error) {
    if (requireSuccess) throw error;
    console.error("Failed to list Gitea labels for ensureLabelsExistGitea", {
      repositoryOwner,
      repositoryName,
      error,
    });
    return map;
  }

  const nameToId = labelIdsByName(existingLabels);

  for (const name of labels) {
    try {
      const existingId = nameToId.get(name);
      if (existingId !== undefined) {
        map.set(name, existingId);
        continue;
      }

      const color = getLabelColor(name);
      const created = await write(() =>
        client.createLabel(repositoryOwner, repositoryName, name, color),
      );
      nameToId.set(name, created.id);
      map.set(name, created.id);
    } catch (error) {
      if (requireSuccess) throw error;
      console.error(`Failed to ensure Gitea label "${name}":`, error);
    }
  }
  return map;
}

export async function addLabelsToIssueGitea(
  config: GiteaConfig,
  issueIndex: number,
  labelNames: string[],
  requireSuccess = false,
  write: IssueWrite = (send) => send(),
) {
  if (labelNames.length === 0) return;

  const client = createGiteaClient(config);
  let carried: string[];
  try {
    carried = await issueLabelNames(client, config, issueIndex);
  } catch (error) {
    if (requireSuccess) throw error;
    console.error("Failed to read Gitea issue labels:", error);
    return;
  }
  const missing = labelNames.filter((name) => !carried.includes(name));
  if (missing.length === 0) return;

  const nameToId = await ensureLabelsExistGitea(
    config,
    missing,
    requireSuccess,
    write,
  );
  const ids: number[] = [];
  for (const name of missing) {
    const id = nameToId.get(name);
    if (id !== undefined) {
      ids.push(id);
    }
  }

  if (ids.length === 0) return;

  try {
    await write(() =>
      client.addLabelsToIssue(
        config.repositoryOwner,
        config.repositoryName,
        issueIndex,
        ids,
      ),
    );
  } catch (error) {
    if (requireSuccess) throw error;
    console.error("Failed to add labels to Gitea issue:", error);
  }
}

async function issueLabelNames(
  client: ReturnType<typeof createGiteaClient>,
  config: GiteaConfig,
  issueIndex: number,
) {
  const issue = await client.getIssue(
    config.repositoryOwner,
    config.repositoryName,
    issueIndex,
  );
  return (issue.labels ?? []).map((l) => l.name);
}

export async function removeLabelGitea(
  config: GiteaConfig,
  issueIndex: number,
  labelName: string,
  write: IssueWrite = (send) => send(),
  requireSuccess = false,
) {
  const client = createGiteaClient(config);
  let labels: GiteaLabel[];
  try {
    const issue = await client.getIssue(
      config.repositoryOwner,
      config.repositoryName,
      issueIndex,
    );
    labels = (issue.labels ?? []).filter((l) => l.name === labelName);
  } catch (error) {
    if (requireSuccess) throw error;
    console.error("Failed to read Gitea issue labels for removal:", {
      repositoryOwner: config.repositoryOwner,
      repositoryName: config.repositoryName,
      issueIndex,
      labelName,
      error,
    });
    return;
  }

  for (const label of labels) {
    try {
      await write(() =>
        client.removeLabelFromIssue(
          config.repositoryOwner,
          config.repositoryName,
          issueIndex,
          label.id,
        ),
      );
    } catch (error) {
      if (requireSuccess) throw error;
      console.error("Failed to remove label from Gitea issue:", {
        repositoryOwner: config.repositoryOwner,
        repositoryName: config.repositoryName,
        issueIndex,
        labelName,
        labelId: label.id,
        error,
      });
    }
  }
}
