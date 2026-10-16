import { describe, expect, it } from "vitest"

import { ApiError, plainMessage } from "./client"

describe("plainMessage", () => {
  it("gives the server's own sentence, without the status and path", () => {
    expect(plainMessage(new ApiError(400, "Ask for fewer.", "/x"))).toBe("Ask for fewer.")
    expect(plainMessage(new ApiError(422, { problems: [] }, "/x"))).toBe('422 /x: {"problems":[]}')
    expect(plainMessage(new Error("boom"))).toBe("boom")
    expect(plainMessage("odd")).toBe("odd")
  })
})
