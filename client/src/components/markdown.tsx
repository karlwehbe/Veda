// Shared Markdown renderer for assistant messages and the notes panel, so
// both get the same plugin set: GFM (tables, task lists), LaTeX math, and
// inline HTML.
//
// Math: remark-math only recognizes the dollar delimiters ($x$ / $$x$$), but
// LLMs very often emit the LaTeX-native \( x \) and \[ x \] forms instead —
// and in Markdown a backslash before a paren is just an escape, so those
// render as literal parens with raw TeX inside them ("i hat (( \hat{i} ))").
// normalizeMath rewrites them before parsing, which also fixes notes already
// stored that way.
//
// Dollar corruption: the model sometimes writes the Unicode escape for "$"
// (\u0024) instead of the character. That shows up as literal \u0024, or
// gets partially decoded to STX+"4" (\x024). repairMangledDollars turns
// those back into real $ delimiters before anything else runs.
//
// Over-escaping: structured output often yields \\hat instead of \hat.
// KaTeX treats \\ as a linebreak, so each letter of "hat" stacks vertically
// — collapse \\ before a TeX command letter back to a single backslash.
//
// Missing/corrupt backslash: the opposite failure stores $\x05hat{i}$ (a C0
// control char) or $hat{i}$ with no slash at all — KaTeX paints those red.
// restoreMissingBackslash repairs both before rehype-katex runs.
//
// Display promotion: a lone $$...$$ or a substantial $...$ equation on its
// own line gets blank lines so it becomes .katex-display. Short tokens like
// $n$ or $\hat{i}$ stay inline — promoting those made every variable a
// full-width centered equation.
//
// Diagrams: ```mermaid fences are intercepted and rendered as SVG rather
// than shown as source. Handled on the <pre> rather than the <code> element
// because a diagram is a block-level container, and returning one from the
// code component would nest a <div> inside a <pre> — flow content inside an
// element that only accepts phrasing content.
//
// HTML: react-markdown escapes raw HTML by default, so model-written markup
// like Notion-style <aside> callouts showed up as visible tags. rehype-raw
// parses it for real; rehype-sanitize then strips anything unsafe, since
// this markup is model-generated and can be influenced by whatever ends up
// in a transcript.
import type { ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import rehypeKatex from "rehype-katex"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

import { MermaidDiagram } from "@/components/mermaid-diagram"
import { resolveSlideSrc, slideIdFromSrc } from "@/lib/slides"

// The default (GitHub-derived) schema already allows details/summary and
// the usual block/inline tags, but drops these semantic ones — which are
// exactly what the model reaches for when writing callouts and figures.
const EXTRA_TAGS = ["aside", "figure", "figcaption", "mark", "kbd", "abbr", "small", "u"]

const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...EXTRA_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    // Lets streaming pending-TeX keep a mild size tweak without using <small>.
    em: [...(defaultSchema.attributes?.em ?? []), ["className", "pending-tex"]],
  },
}

// \u0024 is "$". Models emit it literally (often *inside* real $...$
// delimiters); decoders sometimes turn \u00024 into STX+"4". Map every
// mangled form to a sentinel, drop sentinels that sit next to a real $,
// then turn any leftovers into $.
export function repairMangledDollars(text: string): string {
  const M = "\uE000"
  let t = text
    .replace(/\\u0024/gi, M)
    .replace(/\\U00000024/g, M)
    .replace(/\\u00024/gi, M)
    .replace(/\u00024/g, M)
  // $\u0024x\u0024$ → $x$ (inner escapes were redundant copies of the $).
  t = t.replaceAll(`$${M}`, "$").replaceAll(`${M}$`, "$")
  t = t.replaceAll(M, "$")
  // Rare leftover from overlapping repairs.
  t = t.replace(/\${3,}/g, (run) => (run.length % 2 === 0 ? "$$" : "$"))
  return t
}

// \\frac → \frac, etc.
//
// Only collapses when a *known command name* follows. The earlier version
// matched \\ before any letter, which ate matrix row separators: in
// \begin{bmatrix}a&b\\c&d\end{bmatrix} the \\ before "c" is a row break, and
// turning it into \c produced an undefined command that KaTeX rendered as
// red source. Rows starting with a digit were unaffected, so numeric
// matrices rendered and symbolic ones did not.
export function collapseOverEscapedCommands(body: string): string {
  // Built here rather than inlined so it stays tied to TEX_CMD below —
  // begin/end are added because an over-escaped \\begin breaks an
  // environment just as badly, and no row ever starts with them.
  const overEscaped = new RegExp(String.raw`\\\\(${TEX_CMD}|begin|end)\b`, "g")
  let prev = ""
  let next = body
  // Repeat: $\\\hat$ (three slashes) needs more than one pass.
  while (prev !== next) {
    prev = next
    next = next.replace(overEscaped, "\\$1")
  }
  return next
}

// Structured output sometimes drops or corrupts the backslash before a TeX
// command. Seen in production: $\x05hat{i}$ (ENQ) and $hat{i}$ (no slash).
// Restore a real backslash so KaTeX can parse the command.
const TEX_CMD =
  "hat|vec|bar|dot|tilde|widehat|overline|frac|sqrt|sum|prod|int|partial|nabla|mathbf|mathrm|boldsymbol|operatorname|text|left|right|cdot|times|ldots|cdots|infty|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|mathbb|mathcal"

export function restoreMissingBackslash(body: string): string {
  let next = body
    // Any C0 control char (except tab/newline) before a command name → \.
    // Runs after repairMangledDollars so STX+"4" dollars aren't mistaken
    // for a missing backslash.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F](?=[a-zA-Z])/g, "\\")
  // $hat{i}$ or " xhat{" mid-math → insert \ before known commands.
  next = next.replace(new RegExp(`(?<!\\\\)\\b(${TEX_CMD})(?=[\\s{])`, "g"), "\\$1")
  return next
}

export function fixMathBody(body: string): string {
  return collapseOverEscapedCommands(restoreMissingBackslash(repairMangledDollars(body)))
}

// Real equations deserve display; lone variables and unit vectors do not.
export function isDisplayWorthy(body: string): boolean {
  const t = body.trim()
  if (t.length >= 12) return true
  if (/[=≠≈≤≥+]/.test(t)) return true
  if (/\\(frac|sum|int|prod|lim|begin|partial|nabla|times|ne|neq)/.test(t)) return true
  return false
}

// Splitting on fenced/inline code first means delimiters inside code samples
// are left exactly as written rather than being turned into math.
export function normalizeMath(markdown: string): string {
  const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return segments
    .map((segment, i) => {
      if (i % 2 === 1) return segment // the captured code spans
      let text = repairMangledDollars(segment)
      return (
        text
          // \[...\] → fenced display math (blank lines so Markdown treats it
          // as its own block — chat replies often omit those).
          .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => {
            const fixed = fixMathBody(body.trim())
            return isDisplayWorthy(fixed)
              ? `\n\n$$\n${fixed}\n$$\n\n`
              : `$${fixed}$`
          })
          .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${fixMathBody(body)}$`)
          // Dollar repair can turn $\u0024x\u0024$ into $$x$$ — demote short
          // ones back to inline so unit vectors don't become display blocks.
          .replace(/\$\$([\s\S]*?)\$\$/g, (_, body: string) => {
            const fixed = fixMathBody(body.trim())
            return isDisplayWorthy(fixed)
              ? `\n\n$$\n${fixed}\n$$\n\n`
              : `$${fixed}$`
          })
          .replace(/\$([^$\n]+)\$/g, (_, body: string) => `$${fixMathBody(body)}$`)
          // Lone $...$ on a line → display only when it looks like an equation.
          .replace(/^[ \t]*\$([^$\n]+)\$[ \t]*$/gm, (full, body: string) =>
            isDisplayWorthy(body) ? `\n\n$$\n${body.trim()}\n$$\n\n` : full
          )
          // Collapse runs of blank lines left by the replacements above.
          .replace(/\n{3,}/g, "\n\n")
      )
    })
    .join("")
}

// While a reply is still being revealed token-by-token, an opening $, $$,
// \(, or \[ without its closer makes remark-math treat the rest of the
// string as one math node. KaTeX then paints a giant half-parsed equation
// for a frame right before the closing delimiter arrives.
//
// Split so finished markdown (including complete math) still renders, and
// the unfinished span is returned separately — the chat UI streams it as
// plain TeX, then swaps to KaTeX once the closer lands.
export function splitIncompleteMath(markdown: string): {
  complete: string
  pending: string
} {
  let i = 0
  while (i < markdown.length) {
    // Fenced code — skip intact fences; if the fence never closes, leave
    // the tail alone (mermaid/code streaming is a separate concern).
    if (markdown.startsWith("```", i)) {
      const end = markdown.indexOf("```", i + 3)
      if (end === -1) return { complete: markdown, pending: "" }
      i = end + 3
      continue
    }
    // Inline code.
    if (markdown[i] === "`") {
      const end = markdown.indexOf("`", i + 1)
      if (end === -1) {
        return { complete: markdown.slice(0, i), pending: markdown.slice(i) }
      }
      i = end + 1
      continue
    }
    // Display $$...$$ (check before single $).
    if (markdown.startsWith("$$", i)) {
      const end = markdown.indexOf("$$", i + 2)
      if (end === -1) {
        return { complete: markdown.slice(0, i), pending: markdown.slice(i) }
      }
      i = end + 2
      continue
    }
    // LaTeX-native display/inline.
    if (markdown.startsWith("\\[", i)) {
      const end = markdown.indexOf("\\]", i + 2)
      if (end === -1) {
        return { complete: markdown.slice(0, i), pending: markdown.slice(i) }
      }
      i = end + 2
      continue
    }
    if (markdown.startsWith("\\(", i)) {
      const end = markdown.indexOf("\\)", i + 2)
      if (end === -1) {
        return { complete: markdown.slice(0, i), pending: markdown.slice(i) }
      }
      i = end + 2
      continue
    }
    // Inline $...$ — remark-math does not cross newlines.
    if (markdown[i] === "$") {
      let j = i + 1
      while (j < markdown.length && markdown[j] !== "$" && markdown[j] !== "\n") j++
      if (j >= markdown.length || markdown[j] !== "$") {
        return { complete: markdown.slice(0, i), pending: markdown.slice(i) }
      }
      i = j + 1
      continue
    }
    i++
  }
  return { complete: markdown, pending: "" }
}

/** Strip the opening delimiter so pending math streams as bare TeX source.
 *  Collapse whitespace so `$$\n\begin{…}` doesn't jump onto multiple lines
 *  while it's still plain text. */
export function pendingMathPlain(pending: string): string {
  let body = pending
  if (body.startsWith("$$")) body = body.slice(2)
  else if (body.startsWith("\\[")) body = body.slice(2)
  else if (body.startsWith("\\(")) body = body.slice(2)
  else if (body.startsWith("$")) body = body.slice(1)
  return body.replace(/\s+/g, " ").trimStart()
}

/** Wrap pending TeX as italic HTML so it stays in-flow (black, italic) inside
 *  the same markdown paragraph — rehype-raw will parse the <em>. Slightly
 *  smaller than body text via .pending-tex, but not as small as <small>. */
export function pendingMathItalicHtml(pending: string): string {
  const plain = pendingMathPlain(pending)
  if (!plain) return ""
  const escaped = plain
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return `<em class="pending-tex">${escaped}</em>`
}

/** @deprecated Prefer splitIncompleteMath — kept for call sites that only need the safe prefix. */
export function clipIncompleteMath(markdown: string): string {
  return splitIncompleteMath(markdown).complete
}

// react-markdown hands <pre> a single <code> child. Returns the diagram
// source when that child is a mermaid fence, null otherwise.
export function mermaidSource(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!child || typeof child !== "object" || !("props" in child)) return null
  const props = child.props as { className?: string; children?: ReactNode }
  // rehype-sanitize's default schema allows className on <code> when it
  // matches /^language-./, so the fence's language survives sanitizing.
  if (!props.className?.split(/\s+/).includes("language-mermaid")) return null
  const source = Array.isArray(props.children) ? props.children.join("") : props.children
  return typeof source === "string" && source.trim() ? source.trim() : null
}

// Slides: the server injects each one into the notes as ![alt](/slides/{id}/image).
// Those are served by the API rather than the page's own origin, so the src is
// pointed there, and the image links to full size. It's a <span> tree rather
// than <figure>/<div>: a Markdown image sits inside a <p>, which only accepts
// phrasing content. Capped at 640px and centred: slides are rendered 1280px wide,
// and the notes panel has no maximum width of its own, so without a cap a slide
// would grow to fill a very wide panel.
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      // Order matters. raw parses the HTML into a real tree; sanitize then
      // cleans it; katex runs LAST because it injects its own classed markup,
      // and the sanitize schema doesn't allow className — running it after
      // sanitize is what keeps rendered equations from being stripped.
      rehypePlugins={[
        rehypeRaw,
        [rehypeSanitize, schema],
        // throwOnError: false so one malformed expression renders in red
        // instead of blanking the whole document.
        [rehypeKatex, { throwOnError: false }],
      ]}
      components={{
        pre(props) {
          const chart = mermaidSource(props.children)
          return chart ? <MermaidDiagram chart={chart} /> : <pre {...props} />
        },
        img({ src, alt, title }) {
          if (typeof src !== "string" || !slideIdFromSrc(src)) return <img src={src} alt={alt ?? ""} title={title} />
          const full = resolveSlideSrc(src)
          return (
            <span className="relative mx-auto my-5 block max-w-[640px]">
              <a href={full} target="_blank" rel="noreferrer" title="Open full size">
                <img
                  src={full}
                  alt={alt ?? ""}
                  loading="lazy"
                  className="m-0 block h-auto w-full rounded-lg border border-border"
                />
              </a>
            </span>
          )
        },
      }}
    >
      {normalizeMath(children)}
    </ReactMarkdown>
  )
}
