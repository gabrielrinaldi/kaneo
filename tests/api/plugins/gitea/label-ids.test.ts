import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  addLabelsToIssueGitea,
  ensureLabelsExistGitea,
  removeLabelGitea,
} from "../../../../apps/api/src/plugins/gitea/utils/labels";

type Label = { id: number; name: string };

const gitea = vi.hoisted(() => ({
  labels: [] as { id: number; name: string }[],
  issueLabels: [] as { id: number; name: string }[],
  nextId: 1,
  requests: [] as string[],
}));

vi.mock("../../../../apps/api/src/utils/assert-public-destination", () => ({
  assertPublicDestination: async () => {},
}));

vi.mock("../../../../apps/api/src/import/destination-fetch", () => ({
  destinationFetch: async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v1/repos/o/r", "");
    gitea.requests.push(`${method} ${path}`);
    const json = (body: unknown) => new Response(JSON.stringify(body));
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (method === "GET" && path === "/labels") {
      const limit = Number(url.searchParams.get("limit") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return json(
        gitea.labels.slice(
          (page - 1) * Math.min(limit, 30),
          page * Math.min(limit, 30),
        ),
      );
    }
    if (method === "POST" && path === "/labels") {
      const { name } = JSON.parse(String(init?.body));
      const label = { id: gitea.nextId++, name };
      gitea.labels.push(label);
      return json(label);
    }
    if (method === "GET" && path === "/issues/1") {
      return json({ id: 1, number: 1, labels: gitea.issueLabels });
    }
    if (method === "POST" && path === "/issues/1/labels") {
      const { labels } = JSON.parse(String(init?.body)) as { labels: number[] };
      for (const id of labels) {
        const label = gitea.labels.find((l) => l.id === id);
        if (label && !gitea.issueLabels.some((l) => l.id === id))
          gitea.issueLabels.push(label);
      }
      return json(gitea.issueLabels);
    }
    const removal = path.match(/^\/issues\/1\/labels\/(\d+)$/);
    if (method === "DELETE" && removal) {
      gitea.issueLabels = gitea.issueLabels.filter(
        (l) => l.id !== Number(removal[1]),
      );
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
}));

const config = {
  baseUrl: "https://gitea.test",
  accessToken: "token",
  repositoryOwner: "o",
  repositoryName: "r",
};

function seed(labels: Label[], issueLabels: Label[]) {
  gitea.labels = labels;
  gitea.issueLabels = issueLabels;
  gitea.nextId = Math.max(0, ...labels.map((l) => l.id)) + 1;
  gitea.requests = [];
}

describe("Gitea label ids", () => {
  beforeEach(() => seed([], []));

  it("removes the duplicate the issue carries and adds the lowest id", async () => {
    const first = { id: 1034, name: "status:done" };
    const second = { id: 1033, name: "status:done" };
    seed(
      [
        first,
        second,
        { id: 1040, name: "status:to-do" },
        { id: 1041, name: "status:to-do" },
      ],
      [second],
    );

    await removeLabelGitea(config, 1, "status:done", undefined, true);
    expect(gitea.issueLabels).toEqual([]);

    const ids = await ensureLabelsExistGitea(config, ["status:done"], true);
    expect(ids.get("status:done")).toBe(1033);
  });

  it("creates one label when ensures run concurrently", async () => {
    seed([{ id: 1, name: "status:to-do" }], []);

    const results = await Promise.all([
      ensureLabelsExistGitea(config, ["status:done"], true),
      ensureLabelsExistGitea(config, ["status:done"], true),
      ensureLabelsExistGitea(config, ["status:done"], true),
    ]);

    expect(gitea.labels.filter((l) => l.name === "status:done")).toHaveLength(
      1,
    );
    expect(new Set(results.map((r) => r.get("status:done"))).size).toBe(1);
  });

  it("finds labels past the first page", async () => {
    const labels = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1,
      name: `label-${i + 1}`,
    }));
    seed(labels, [labels[39] as Label]);

    const ids = await ensureLabelsExistGitea(config, ["label-40"], true);
    expect(ids.get("label-40")).toBe(40);
    expect(gitea.labels).toHaveLength(45);

    await removeLabelGitea(config, 1, "label-40", undefined, true);
    expect(gitea.issueLabels).toEqual([]);
  });

  it("does not write labels the issue already carries", async () => {
    const done = { id: 7, name: "status:done" };
    seed([done], [done]);

    await addLabelsToIssueGitea(config, 1, ["status:done"], true);

    expect(gitea.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
  });
});
