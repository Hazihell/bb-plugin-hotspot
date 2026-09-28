/**
 * The wire contract between the server and the app bundle.
 *
 * `app.tsx` imports only the inferred types (`import type`), so zod never
 * reaches the frontend bundle.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { episodeViewSchema, sampleViewSchema, timelinePointSchema } from "./schemas";

export const RANGES = ["24h", "7d"] as const;
export type Range = (typeof RANGES)[number];

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      latest: sampleViewSchema.nullable(),
      open: episodeViewSchema.nullable(),
      cpuThreshold: z.number(),
      sampleIntervalSeconds: z.number(),
    }),
  },
  timeline: {
    input: z.object({ range: z.enum(RANGES) }).strict(),
    output: z.object({
      from: z.number(),
      to: z.number(),
      bucketMs: z.number(),
      points: z.array(timelinePointSchema),
      episodes: z.array(episodeViewSchema),
    }),
  },
});

export type { EpisodeView as Episode, SampleView as Sample, TimelinePoint } from "./schemas";
export type Status = z.infer<(typeof rpcContract)["status"]["output"]>;
export type Timeline = z.infer<(typeof rpcContract)["timeline"]["output"]>;
