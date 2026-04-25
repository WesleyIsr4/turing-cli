import { afterEach, describe, expect, test } from "bun:test"
import { resource } from "../../src/effect/observability"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const opencodeClient = process.env.TURING_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (opencodeClient === undefined) delete process.env.TURING_CLIENT
  else process.env.TURING_CLIENT = opencodeClient
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=trinca,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "trinca",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=trinca,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["turing.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.TURING_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "turing.client=web,service.instance.id=override,service.namespace=trinca"

    expect(resource().attributes).toMatchObject({
      "turing.client": "cli",
      "service.namespace": "trinca",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
  })
})
