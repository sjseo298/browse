import { describe, expect, test } from "bun:test"
import {
  isLatestReleaseTag,
  selectLocalDistDirsToPrune,
  selectReleasesToPrune,
  type ReleaseEntry,
} from "../scripts/dist.ts"

describe("dist retention & overwrite guards", () => {
  test("keeps only latest and immediately previous release (numeric semver order)", () => {
    const releases: ReleaseEntry[] = [
      { tagName: "v0.1.6", createdAt: "2026-11-18T10:00:00Z" },
      { tagName: "v0.1.10", createdAt: "2026-11-22T10:00:00Z" },
      { tagName: "v0.1.8", createdAt: "2026-11-20T10:00:00Z" },
      { tagName: "v0.1.7", createdAt: "2026-11-19T10:00:00Z" },
    ]
    const result = selectReleasesToPrune(releases, { keep: 2 })
    expect(result.keep.map((r) => r.tagName)).toEqual(["v0.1.10", "v0.1.8"])
    expect(result.remove.map((r) => r.tagName)).toEqual(["v0.1.7", "v0.1.6"])
  })

  test("keeps all releases when count <= 2", () => {
    const releases: ReleaseEntry[] = [
      { tagName: "v0.1.6", createdAt: "2026-11-18T10:00:00Z" },
      { tagName: "v0.1.7", createdAt: "2026-11-19T10:00:00Z" },
    ]
    const result = selectReleasesToPrune(releases, { keep: 2 })
    expect(result.keep.map((r) => r.tagName)).toEqual(["v0.1.7", "v0.1.6"])
    expect(result.remove).toEqual([])
  })

  test("always preserves protectTag even when newer versions exist", () => {
    const releases: ReleaseEntry[] = [
      { tagName: "v0.1.8" },
      { tagName: "v0.1.7" },
      { tagName: "v0.1.6" },
    ]
    const result = selectReleasesToPrune(releases, { keep: 2, protectTag: "v0.1.6" })
    expect(result.keep.map((r) => r.tagName)).toEqual(["v0.1.8", "v0.1.6"])
    expect(result.remove.map((r) => r.tagName)).toEqual(["v0.1.7"])
  })

  test("rejects invalid keep < 1", () => {
    expect(() => selectReleasesToPrune([], { keep: 0 })).toThrow()
  })

  test("selects only old dist-* local directories for pruning", () => {
    const dirs = ["dist-0.1.6", "dist-0.1.7", "dist-0.1.8", "staging", "browse-extension-0.1.6.zip"]
    expect(selectLocalDistDirsToPrune(dirs, ["v0.1.8", "v0.1.7"])).toEqual(["dist-0.1.6"])
  })

  test("isLatestReleaseTag allows overwriting latest non-draft release and rejects older ones", () => {
    const releases: ReleaseEntry[] = [
      { tagName: "v0.1.8", isDraft: true },
      { tagName: "v0.1.7", isDraft: false },
      { tagName: "v0.1.6", isDraft: false },
    ]
    expect(isLatestReleaseTag(releases, "v0.1.7")).toBe(true)
    expect(isLatestReleaseTag(releases, "v0.1.6")).toBe(false)
    expect(isLatestReleaseTag([], "v0.1.6")).toBe(true)
  })
})
