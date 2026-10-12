import { z } from 'zod'

const invalidProxy =
  '本机代理须为 http://127.0.0.1:端口 或 http://[::1]:端口，不得包含账号、密码、路径或参数。'
const invalidNetwork = '模型网络连接方式无效，请选择直连、系统代理或指定本机代理。'

// Match the original spelling before URL normalization: shortened, integer, encoded,
// and DNS-based loopback hosts must not become an alternate route to local services.
const loopbackProxyUrlSchema = z
  .string({ error: invalidProxy })
  .max(64, invalidProxy)
  .refine((value) => {
    const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value)
    return Boolean(match && match[0] === value && Number(match[1]) <= 65535)
  }, invalidProxy)

export const modelNetworkSchema = z.discriminatedUnion(
  'mode',
  [
    z.strictObject({ mode: z.literal('direct') }, { error: invalidNetwork }),
    z.strictObject({ mode: z.literal('system') }, { error: invalidNetwork }),
    z.strictObject(
      { mode: z.literal('local'), proxyUrl: loopbackProxyUrlSchema },
      { error: invalidNetwork },
    ),
  ],
  { error: invalidNetwork },
)

export type ModelNetworkConfig = z.infer<typeof modelNetworkSchema>
