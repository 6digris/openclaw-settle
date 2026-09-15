// Feishu tests cover comment shared plugin behavior.
import { describe, expect, it } from "vitest";
import { extractReplyText, parseCommentContentElements } from "./comment-shared.js";

function resolveCommentLinkedDocumentFromUrl(params: {
  rawUrl: string;
  currentDocument?: Parameters<typeof parseCommentContentElements>[0]["currentDocument"];
}) {
  const parsed = parseCommentContentElements({
    elements: [{ type: "docs_link", docs_link: { url: params.rawUrl } }],
    currentDocument: params.currentDocument,
  });
  return parsed.linkedDocuments[0] ?? { rawUrl: params.rawUrl, urlKind: "unknown" as const };
}

const VALID_TOKEN_22 = "ABCDEFGHIJKLMNOPQRSTUV";
const VALID_TOKEN_27 = "ZsJfdxrBFo0RwuxteOLc1Ekvneb";

describe("resolveCommentLinkedDocumentFromUrl", () => {
  it.each([
    {
      label: "doc",
      url: `https://example.test/doc/${VALID_TOKEN_22}`,
      expectedKind: "doc",
      expectedResolvedType: "doc",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "docs",
      url: `https://example.test/docs/${VALID_TOKEN_22}`,
      expectedKind: "doc",
      expectedResolvedType: "doc",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/doc",
      url: `https://example.test/space/doc/${VALID_TOKEN_22}`,
      expectedKind: "doc",
      expectedResolvedType: "doc",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "sheet",
      url: `https://example.test/sheet/${VALID_TOKEN_22}`,
      expectedKind: "sheet",
      expectedResolvedType: "sheet",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "sheets",
      url: `https://example.test/sheets/${VALID_TOKEN_22}`,
      expectedKind: "sheet",
      expectedResolvedType: "sheet",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/sheet",
      url: `https://example.test/space/sheet/${VALID_TOKEN_22}`,
      expectedKind: "sheet",
      expectedResolvedType: "sheet",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "docx with hash",
      url: `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}#share-Huggdiqveo5N7NxyA01ck4gLnHh`,
      expectedKind: "docx",
      expectedResolvedType: "docx",
      expectedToken: VALID_TOKEN_27,
    },
    {
      label: "mindnote",
      url: `https://example.test/mindnote/${VALID_TOKEN_22}`,
      expectedKind: "mindnote",
      expectedResolvedType: "mindnote",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "mindnotes",
      url: `https://example.test/mindnotes/${VALID_TOKEN_22}`,
      expectedKind: "mindnote",
      expectedResolvedType: "mindnote",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/mindnote",
      url: `https://example.test/space/mindnote/${VALID_TOKEN_22}`,
      expectedKind: "mindnote",
      expectedResolvedType: "mindnote",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "bitable",
      url: `https://example.test/bitable/${VALID_TOKEN_22}?table=tbl_123`,
      expectedKind: "bitable",
      expectedResolvedType: "bitable",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "base",
      url: `https://example.test/base/${VALID_TOKEN_22}`,
      expectedKind: "base",
      expectedResolvedType: "base",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/bitable",
      url: `https://example.test/space/bitable/${VALID_TOKEN_22}`,
      expectedKind: "bitable",
      expectedResolvedType: "bitable",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "file",
      url: `https://example.test/file/${VALID_TOKEN_22}`,
      expectedKind: "file",
      expectedResolvedType: "file",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/file",
      url: `https://example.test/space/file/${VALID_TOKEN_22}`,
      expectedKind: "file",
      expectedResolvedType: "file",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "wiki",
      url: `https://example.test/wiki/${VALID_TOKEN_22}`,
      expectedKind: "wiki",
      expectedResolvedType: undefined,
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/wiki",
      url: `https://example.test/space/wiki/${VALID_TOKEN_22}`,
      expectedKind: "wiki",
      expectedResolvedType: undefined,
      expectedToken: VALID_TOKEN_22,
    },
  ])("$label", ({ url, expectedKind, expectedResolvedType, expectedToken }) => {
    const linked = resolveCommentLinkedDocumentFromUrl({ rawUrl: url });

    expect(linked.urlKind).toBe(expectedKind);
    expect(linked.resolvedObjType).toBe(expectedResolvedType);
    expect(linked.resolvedObjToken ?? linked.wikiNodeToken).toBe(expectedToken);
  });

  it("does not resolve doc-like paths with short tokens", () => {
    expect(
      resolveCommentLinkedDocumentFromUrl({
        rawUrl: "https://www.baidu.com/docx/guide",
      }),
    ).toEqual({
      rawUrl: "https://www.baidu.com/docx/guide",
      urlKind: "unknown",
    });
  });
});

describe("parseCommentContentElements", () => {
  it("keeps raw external urls in text but excludes unresolved links from structured references", () => {
    const parsed = parseCommentContentElements({
      elements: [
        {
          type: "docs_link",
          docs_link: { url: `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}` },
        },
        {
          type: "text_run",
          text_run: { text: " 和 " },
        },
        {
          type: "docs_link",
          docs_link: { url: "https://www.baidu.com/docx/guide" },
        },
      ],
    });

    expect(parsed.plainText).toBe(
      `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27} 和 https://www.baidu.com/docx/guide`,
    );
    expect(parsed.linkedDocuments).toEqual([
      {
        rawUrl: `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}`,
        urlKind: "docx",
        resolvedObjType: "docx",
        resolvedObjToken: VALID_TOKEN_27,
        isCurrentDocument: false,
      },
    ]);
  });
});

describe("comment element selection", () => {
  it.each([
    {
      element: {
        type: " person ",
        person: { user_id: " bot " },
        mention: { user_id: "ignored", name: " Bot ", display_name: "Ignored" },
        name: "Ignored",
        text: "ignored fallback",
      },
      userId: "bot",
      displayText: "@Bot",
      isBotMention: true,
      semanticText: "before after",
    },
    {
      element: {
        type: "mention",
        mention: { user_id: " member ", open_id: "ignored", display_name: " Member " },
        mention_user: "ignored",
        user_id: "ignored",
        name: "Ignored",
      },
      userId: "member",
      displayText: "@Member",
      isBotMention: false,
      semanticText: "before @Member after",
    },
    {
      element: {
        type: "mention_user",
        mention: { open_id: " open " },
        mention_user: "ignored",
        name: " Open ",
      },
      userId: "open",
      displayText: "@Open",
      isBotMention: false,
      semanticText: "before @Open after",
    },
    {
      element: { type: "mention_user", mention_user: " alias ", user_id: "ignored" },
      userId: "alias",
      displayText: "@alias",
      isBotMention: false,
      semanticText: "before @alias after",
    },
    {
      element: { type: "person", user_id: " direct " },
      userId: "direct",
      displayText: "@direct",
      isBotMention: false,
      semanticText: "before @direct after",
    },
  ])("preserves mention precedence for $userId", (testCase) => {
    const elements = [{ text: "before " }, testCase.element, { text: " after" }];
    const original = structuredClone(elements);
    const plainText = `before ${testCase.displayText} after`;
    expect(parseCommentContentElements({ elements, botOpenIds: [undefined, " bot "] })).toEqual({
      plainText,
      semanticText: testCase.semanticText,
      mentions: [
        {
          userId: testCase.userId,
          displayText: testCase.displayText,
          isBotMention: testCase.isBotMention,
        },
      ],
      linkedDocuments: [],
      botMentioned: testCase.isBotMention,
    });
    expect(extractReplyText({ content: { elements } })).toBe(plainText);
    expect(elements).toEqual(original);
  });

  it.each(["docs_link", "link"])("preserves %s URL priority and reference order", (type) => {
    const current = `https://example.test/docx/${VALID_TOKEN_22}`;
    const other = `https://example.test/doc/${VALID_TOKEN_27}`;
    const wiki = `https://example.test/wiki/${VALID_TOKEN_22}`;
    const external = "https://example.test/help";
    const elements = [
      { type, docs_link: { url: ` ${current} `, link: other }, url: wiki, text: "ignored" },
      { text: " " },
      { type, docs_link: { url: "", link: other }, url: wiki },
      { text: " " },
      { type, docs_link: {}, url: wiki, link: external },
      { text: " " },
      { type, link: external, content: "ignored" },
      { text: " " },
      { type, url: current },
    ];
    const original = structuredClone(elements);
    const plainText = [current, other, wiki, external, current].join(" ");
    expect(
      parseCommentContentElements({
        elements,
        currentDocument: { fileType: "docx", fileToken: VALID_TOKEN_22 },
      }),
    ).toEqual({
      plainText,
      semanticText: plainText,
      mentions: [],
      linkedDocuments: [
        {
          rawUrl: current,
          urlKind: "docx",
          resolvedObjType: "docx",
          resolvedObjToken: VALID_TOKEN_22,
          isCurrentDocument: true,
        },
        {
          rawUrl: other,
          urlKind: "doc",
          resolvedObjType: "doc",
          resolvedObjToken: VALID_TOKEN_27,
          isCurrentDocument: false,
        },
        { rawUrl: wiki, urlKind: "wiki", wikiNodeToken: VALID_TOKEN_22 },
      ],
      botMentioned: false,
    });
    expect(extractReplyText({ content: { elements } })).toBe(plainText);
    expect(elements).toEqual(original);
  });

  it.each([
    {
      element: { type: "text_run", text_run: { content: "first", text: "second" }, text: "third" },
      text: "first",
    },
    {
      element: { type: "text", text_run: { content: "", text: "nested" }, text: "top" },
      text: "nested",
    },
    {
      element: { type: "text_run", text_run: { text: "" }, text: "top", content: "later" },
      text: "top",
    },
    { element: { type: "text", text: "", content: "content", name: "later" }, text: "content" },
    {
      element: { type: "mention", mention: { user_id: " " }, text_run: { content: "fallback" } },
      text: "fallback",
    },
    {
      element: { type: "docs_link", docs_link: { url: " " }, content: "fallback" },
      text: "fallback",
    },
    { element: { type: "link", url: 1, text: false, name: "name" }, text: "name" },
    { element: { type: "MENTION", user_id: "ignored", name: "plain" }, text: "plain" },
    {
      element: { type: "unknown", text_run: { text: " \n世界🦊 " }, text: "ignored" },
      text: " \n世界🦊 ",
    },
    { element: { type: "text", text_run: { content: "  " }, text: "ignored" }, text: "  " },
    { element: { type: "text", text: "", content: 0, name: false }, text: "" },
  ])("preserves plain fallback for $element.type ($text)", ({ element, text }) => {
    const elements = [null, [], 7, { text: "[" }, element, { text: "]" }];
    const original = structuredClone(elements);
    expect(parseCommentContentElements({ elements })).toEqual({
      plainText: `[${text}]`,
      semanticText: `[${text}]`.replace(/\s+/g, " "),
      mentions: [],
      linkedDocuments: [],
      botMentioned: false,
    });
    expect(extractReplyText({ content: { elements } })).toBe(`[${text}]`);
    expect(elements).toEqual(original);
  });
});
