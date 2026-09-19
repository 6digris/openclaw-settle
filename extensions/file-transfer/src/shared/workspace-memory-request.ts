import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Paths whose existing file grants must admit a native Memory operation. */
export function readWorkspaceMemoryRequest(value: unknown) {
  const params = asOptionalRecord(value);
  const workspaceDir = params?.workspaceDir;
  if (
    typeof workspaceDir !== "string" ||
    !path.posix.isAbsolute(workspaceDir) ||
    workspaceDir.includes("\0") ||
    typeof params?.request !== "string" ||
    typeof params.watch !== "boolean"
  ) {
    throw new Error("Invalid node Memory request");
  }
  const workspace = path.posix.resolve(workspaceDir);
  const request = asOptionalRecord(JSON.parse(params.request));
  if (!request) {
    throw new Error("Memory request must be an object");
  }
  const paths: { path: string; kind: "read" | "write" }[] = [];
  const add = (input: unknown, kind: "read" | "write" = "read") => {
    if (typeof input !== "string" || !input || input.includes("\0")) {
      throw new Error("Memory operation requires a file path");
    }
    const resolved = path.posix.resolve(workspace, input);
    const relative = path.posix.relative(workspace, resolved);
    if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      throw new Error("Memory path is outside the configured node workspace");
    }
    paths.push({ path: resolved, kind });
  };
  const extra = (values: unknown) => {
    if (values === undefined) {
      return;
    }
    if (!Array.isArray(values)) {
      throw new Error("Invalid extra Memory paths");
    }
    for (const entry of values) {
      add(typeof entry === "string" ? entry : asOptionalRecord(entry)?.path);
    }
  };
  if (params.watch) {
    add(workspace);
    extra(asOptionalRecord(request.settings)?.extraPaths);
  } else {
    switch (request.operation) {
      case "list":
        add(workspace);
        extra(request.extraPaths);
        break;
      case "inspect":
      case "readForIndexing":
        add(request.filePath);
        break;
      case "read": {
        const read = asOptionalRecord(request.params);
        add(read?.relPath);
        extra(read?.extraPaths);
        break;
      }
      case "multimodal":
        add(asOptionalRecord(request.entry)?.absPath);
        break;
      case "maintenance": {
        const args = Array.isArray(request.args) ? request.args : [];
        switch (request.method) {
          case "readFile":
          case "stat":
          case "listDirectory":
          case "readDreams":
            add(args[0]);
            break;
          case "mkdir":
          case "resolveWritePath":
          case "writeDreams":
          case "replaceReport":
          case "appendCorpus":
            add(args[0], "write");
            break;
          case "rename":
            add(args[0], "write");
            add(args[1], "write");
            break;
          case "commitContent":
            add(asOptionalRecord(args[0])?.filePath, "write");
            break;
          case "resolveDreamsPath":
            add(workspace);
            break;
          default:
            throw new Error("Unknown Memory maintenance operation");
        }
        break;
      }
      default:
        throw new Error("Unknown Memory file operation");
    }
  }
  return { workspaceDir: workspace, request: params.request, watch: params.watch, paths };
}
