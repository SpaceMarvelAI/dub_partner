import { Index } from "@upstash/vector";

export const vectorIndex = new Index({
  url: process.env.UPSTASH_VECTOR_REST_URL || "https://placeholder.upstash.io",
  token: process.env.UPSTASH_VECTOR_REST_TOKEN || "placeholder",
});
