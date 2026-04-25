export * from "./client.js"
export * from "./server.js"

import { createTuringClient } from "./client.js"
import { createOpencodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createOpencode(options?: ServerOptions) {
  const server = await createOpencodeServer({
    ...options,
  })

  const client = createTuringClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
