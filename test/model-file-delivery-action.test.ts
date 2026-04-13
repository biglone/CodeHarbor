import { describe, expect, it } from "vitest";

import {
  buildRecentArtifactDeliveryContext,
  parseModelFileDeliveryAction,
  resolveModelFileDeliveryAction,
} from "../src/orchestrator/model-file-delivery-action";
import type { RecentArtifactBatch } from "../src/orchestrator/file-send-intent";

describe("model file delivery action", () => {
  const recentArtifactBatches: RecentArtifactBatch[] = [
    {
      requestId: "req-1",
      workdir: "/tmp/workdir",
      createdAt: 1_700_000_000_000,
      files: [
        {
          absolutePath: "/tmp/workdir/video/episode-10.mp4",
          relativePath: "video/episode-10.mp4",
          sizeBytes: 1024,
          mtimeMs: 1_700_000_000_100,
        },
        {
          absolutePath: "/tmp/workdir/video/episode-9.mp4",
          relativePath: "video/episode-9.mp4",
          sizeBytes: 2048,
          mtimeMs: 1_700_000_000_090,
        },
      ],
    },
  ];

  it("builds recent artifact prompt context", () => {
    const context = buildRecentArtifactDeliveryContext(recentArtifactBatches);
    expect(context).toContain("[codeharbor_action]");
    expect(context).toContain("video/episode-10.mp4");
  });

  it("parses and strips model action block", () => {
    const parsed = parseModelFileDeliveryAction(
      "收到，我现在发给你。\n[codeharbor_action]\n{\"type\":\"send_files\",\"files\":[\"video/episode-10.mp4\",\"video/episode-9.mp4\"]}\n[/codeharbor_action]",
    );
    expect(parsed.cleanReply).toBe("收到，我现在发给你。");
    expect(parsed.action).toEqual({
      type: "send_files",
      files: ["video/episode-10.mp4", "video/episode-9.mp4"],
    });
  });

  it("resolves model action only from registered recent artifacts", () => {
    const parsed = parseModelFileDeliveryAction(
      "[codeharbor_action]\n{\"type\":\"send_files\",\"files\":[\"video/episode-10.mp4\",\"missing.mp4\"]}\n[/codeharbor_action]",
    );
    expect(parsed.action).not.toBeNull();

    const resolved = resolveModelFileDeliveryAction({
      action: parsed.action!,
      recentArtifactBatches,
    });

    expect(resolved.files.map((file) => file.relativePath)).toEqual(["video/episode-10.mp4"]);
    expect(resolved.missingFiles).toEqual(["missing.mp4"]);
  });
});
