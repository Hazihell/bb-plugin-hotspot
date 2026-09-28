/**
 * The wire contract between the server and the app bundle.
 *
 * `app.tsx` imports only the inferred types (`import type`), so zod never
 * reaches the frontend bundle.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadEntrySchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  cpu: z.number(),
  processes: z.number(),
});

const processEntrySchema = z.object({ pid: z.number(), name: z.string(), cpu: z.number() });

export const sampleSchema = z.object({
  at: z.number(),
  thermal: z.number().nullable(),
  cpu: z.number(),
  load: z.number(),
  threads: z.array(threadEntrySchema),
  procs: z.array(processEntrySchema),
});

export const episodeSchema = z.object({
  id: z.number().nullable(),
  startAt: z.number(),
  endAt: z.number().nullable(),
  lastHotAt: z.number(),
  peakThermal: z.number().nullable(),
  peakCpu: z.number(),
  samples: z.number(),
  culprits: z.array(
    z.object({
      threadId: z.string(),
      title: z.string().nullable(),
      cpuSum: z.number(),
      samples: z.number(),
      peakCpu: z.number(),
    }),
  ),
  others: z.array(z.object({ name: z.string(), cpuSum: z.number(), samples: z.number() })),
});

export const RANGES = ["24h", "7d"] as const;
export type Range = (typeof RANGES)[number];

export const timelinePointSchema = z.object({
  at: z.number(),
  /** Highest machine CPU in the bucket, or null when nothing was sampled. */
  cpu: z.number().nullable(),
  /** Highest thermal level in the bucket, or null when unknown. */
  thermal: z.number().nullable(),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      latest: sampleSchema.nullable(),
      open: episodeSchema.nullable(),
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
      episodes: z.array(episodeSchema),
    }),
  },
});

export type Sample = z.infer<typeof sampleSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type TimelinePoint = z.infer<typeof timelinePointSchema>;
export type Status = z.infer<(typeof rpcContract)["status"]["output"]>;
export type Timeline = z.infer<(typeof rpcContract)["timeline"]["output"]>;
