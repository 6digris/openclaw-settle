import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderArtifactsMarkdown, writeMeetExportBundle } from "./cli-export.js";
import type { GoogleMeetArtifactsResult, GoogleMeetAttendanceResult } from "./meet-api.js";

const emptyArtifacts: GoogleMeetArtifactsResult = {
  conferenceRecords: [],
  artifacts: [],
};

const emptyAttendance: GoogleMeetAttendanceResult = {
  conferenceRecords: [],
  attendance: [],
};

function createMarkdownArtifacts(): GoogleMeetArtifactsResult {
  const conferenceRecords = [{ name: "records/second" }, { name: "records/first" }];
  return {
    input: "meeting",
    space: { name: "spaces/test" },
    conferenceRecords,
    artifacts: [
      {
        conferenceRecord: conferenceRecords[0]!,
        participants: [{ name: "participants/1", anonymousUser: { displayName: "Speaker" } }],
        recordings: [],
        transcripts: [
          { name: "transcripts/2", documentText: "  🦊 \n" },
          {
            name: "transcripts/1",
            documentText: " body\nraw *md* ",
            documentTextError: "document warning",
          },
          { name: "transcripts/empty", documentText: "" },
          { name: "transcripts/missing" },
          { name: "transcripts/space", documentText: " \t\n" },
        ],
        transcriptEntries: [
          {
            transcript: "transcripts/2",
            entries: [{ name: "entries/1", participant: "participants/1", text: "spoken" }],
          },
          { transcript: "transcripts/1", entries: [], entriesError: "entry warning" },
        ],
        smartNotes: [
          { name: "notes/*1*", documentText: " notes\n raw " },
          { name: "notes/*1*", documentText: "x", documentTextError: "note warning" },
        ],
      },
      {
        conferenceRecord: conferenceRecords[1]!,
        participants: [],
        recordings: [],
        transcripts: [],
        transcriptEntries: [],
        smartNotes: [],
      },
    ],
  };
}

async function expectSiblingZip(params: {
  suppliedOutputDir: string;
  outputDir: string;
  zipPath: string;
}): Promise<void> {
  const result = await writeMeetExportBundle({
    outputDir: params.suppliedOutputDir,
    artifacts: emptyArtifacts,
    attendance: emptyAttendance,
    zip: true,
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(params.outputDir, "manifest.json"), "utf8"),
  ) as { zipFile?: string };
  expect(result.outputDir).toBe(params.suppliedOutputDir);
  expect(result.zipFile).toBe(params.zipPath);
  expect(manifest.zipFile).toBe(params.zipPath);
  expect(fs.existsSync(params.zipPath)).toBe(true);
  expect(fs.existsSync(path.join(params.outputDir, ".zip"))).toBe(false);
}

describe("Google Meet export publication", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-export-publication-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("renders ordered document summaries around transcript entries", () => {
    expect(renderArtifactsMarkdown(createMarkdownArtifacts())).toBe(
      [
        "# Google Meet Artifacts",
        "Input: meeting",
        "Space: spaces/test",
        "",
        "Conference records: 2",
        "",
        "## records/second",
        "Started: n/a",
        "Ended: n/a",
        "",
        "Participants: 1",
        "Recordings: 0",
        "Transcripts: 5",
        "Transcript entries: 1",
        "Smart notes: 2",
        "",
        "### Warnings",
        "- transcripts/1: entry warning",
        "- transcripts/1: document warning",
        "- notes/*1*: note warning",
        "",
        "### Transcripts",
        "- transcripts/2",
        "  - Document body: 6 chars",
        "- transcripts/1",
        "  - Document body warning: document warning",
        "- transcripts/empty",
        "- transcripts/missing",
        "- transcripts/space",
        "  - Document body: 3 chars",
        "",
        "### Transcript Entries: transcripts/2",
        "- Speaker: spoken",
        "",
        "### Transcript Entries: transcripts/1",
        "Warning: entry warning",
        "",
        "### Smart Notes",
        "- notes/*1*",
        "  - Document body: 12 chars",
        "- notes/*1*",
        "  - Document body warning: note warning",
        "",
        "## records/first",
        "Started: n/a",
        "Ended: n/a",
        "",
        "Participants: 0",
        "Recordings: 0",
        "Transcripts: 0",
        "Transcript entries: 0",
        "Smart notes: 0",
        "",
      ].join("\n"),
    );
  });

  it("exports document bodies with their existing whitespace and warning rules", async () => {
    const outputDir = path.join(tempDir, "documents");
    await writeMeetExportBundle({
      outputDir,
      artifacts: createMarkdownArtifacts(),
      attendance: emptyAttendance,
    });
    expect(fs.readFileSync(path.join(outputDir, "transcript.md"), "utf8")).toBe(
      [
        "# Google Meet Transcript",
        "Input: meeting",
        "",
        "## records/second",
        "",
        "### transcripts/2",
        "- Speaker: spoken",
        "",
        "### transcripts/1",
        "Warning: entry warning",
        "",
        "### Transcript Document Bodies",
        "",
        "#### transcripts/2",
        "🦊",
        "",
        "#### transcripts/1",
        "body",
        "raw *md*",
        "",
        "#### transcripts/space",
        "_Empty document body._",
        "",
        "### Smart Note Document Bodies",
        "",
        "#### notes/*1*",
        "notes",
        " raw",
        "",
        "#### notes/*1*",
        "x",
        "",
        "## records/first",
        "_No transcript entries._",
        "",
      ].join("\n"),
    );
  });

  it("omits document body sections when no transcript entry collections exist", async () => {
    const artifacts = createMarkdownArtifacts();
    for (const entry of artifacts.artifacts) {
      entry.transcriptEntries = [];
    }
    const outputDir = path.join(tempDir, "no-entries");
    await writeMeetExportBundle({ outputDir, artifacts, attendance: emptyAttendance });
    expect(fs.readFileSync(path.join(outputDir, "transcript.md"), "utf8")).toBe(
      [
        "# Google Meet Transcript",
        "Input: meeting",
        "",
        "## records/second",
        "_No transcript entries._",
        "",
        "## records/first",
        "_No transcript entries._",
        "",
      ].join("\n"),
    );
  });

  it("keeps an existing bundle member when replacement fails", async () => {
    const outputDir = path.join(tempDir, "bundle");
    const summaryPath = path.join(outputDir, "summary.md");
    fs.mkdirSync(outputDir);
    fs.writeFileSync(summaryPath, "previous summary\n");
    const priorBytes = fs.readFileSync(summaryPath);

    vi.spyOn(fsp, "writeFile").mockImplementationOnce(async (file) => {
      expect(typeof file).toBe("string");
      fs.writeFileSync(file as string, "partial replacement");
      throw new Error("injected write failure");
    });

    await expect(
      writeMeetExportBundle({
        outputDir,
        artifacts: emptyArtifacts,
        attendance: emptyAttendance,
      }),
    ).rejects.toThrow("injected write failure");

    expect(fs.readFileSync(summaryPath)).toEqual(priorBytes);
    expect(fs.readdirSync(outputDir)).toEqual(["summary.md"]);
  });

  it("keeps an existing ZIP when replacement fails", async () => {
    const outputDir = path.join(tempDir, "bundle");
    const zipPath = `${outputDir}.zip`;
    const priorZip = await new JSZip()
      .file("previous.txt", "previous export")
      .generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(zipPath, priorZip);
    const realWriteFile = fsp.writeFile;

    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args) => {
      const [file, data] = args;
      if (Buffer.isBuffer(data)) {
        expect(typeof file).toBe("string");
        fs.writeFileSync(file as string, "partial replacement");
        throw new Error("injected ZIP write failure");
      }
      await Reflect.apply(realWriteFile, fsp, args);
    });

    await expect(
      writeMeetExportBundle({
        outputDir,
        artifacts: emptyArtifacts,
        attendance: emptyAttendance,
        zip: true,
      }),
    ).rejects.toThrow("injected ZIP write failure");

    expect(fs.readFileSync(zipPath)).toEqual(priorZip);
    expect(fs.readdirSync(tempDir).toSorted()).toEqual(["bundle", "bundle.zip"]);
  });

  it.each([
    { label: "repeated native", trailingSeparators: path.sep.repeat(2) },
    ...(process.platform === "win32"
      ? [
          { label: "repeated alternate", trailingSeparators: "//" },
          { label: "mixed", trailingSeparators: "\\/" },
        ]
      : []),
  ])(
    "writes the ZIP beside an output directory with $label trailing separators",
    async ({ trailingSeparators }) => {
      const outputDir = path.join(tempDir, "bundle");
      await expectSiblingZip({
        suppliedOutputDir: `${outputDir}${trailingSeparators}`,
        outputDir,
        zipPath: `${outputDir}.zip`,
      });
    },
  );
});
