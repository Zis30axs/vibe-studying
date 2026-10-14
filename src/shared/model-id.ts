import { z } from 'zod'

/** Model identifiers are provider-defined text, including names with non-ASCII characters. */
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\u0000-\u001f\u007f]*$/)
