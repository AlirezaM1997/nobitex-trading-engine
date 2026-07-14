import { z } from "zod";

const schema = z.object({
  NOBITEX_API_BASE: z.string().url().default("https://apiv2.nobitex.ir"),
  NOBITEX_API_KEY: z.string().optional(),
  NOBITEX_API_SECRET: z.string().optional()
});

const raw = schema.parse(process.env);

export const config = {
  ...raw,
  NOBITEX_API_BASE: raw.NOBITEX_API_BASE.replace(/\/$/, "")
};
