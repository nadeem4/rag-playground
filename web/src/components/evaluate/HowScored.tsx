import type { ReactNode } from "react"

/**
 * "How it is scored", in the side sheet: what Evaluate tests, how a question
 * is marked, the matching step by step with real examples from the Table of
 * figures sample, each number with its technical name and a worked sum, and
 * where to look when a question misses. Every example is the matching the eval
 * step really does (plugins/use_case/eval.py).
 */
export function HowScored() {
  return (
    <>
      <Section title="What it tests">
        <p>Whether your search brings back the right part of the document. It does not ask a chat model for an answer, and it does not grade one.</p>
      </Section>

      <Section title="How a question is marked">
        <p>
          Each question comes with its evidence: the sentence or table row that answers it. If one of the top pieces holds that evidence, the
          question is <strong>found</strong>. If not, it is <strong>missed</strong>.
        </p>
      </Section>

      <Section title="How the text is matched, step by step">
        <p className="text-fg-muted">The examples come from the Table of figures sample.</p>
        <ol className="flex list-decimal flex-col gap-3 pl-6">
          <li>
            <strong>Take the pieces the search returned, in order,</strong> after any reranker. Only the top ones count; Pieces checked says how
            many.
          </li>
          <li>
            <strong>Look for the evidence inside each piece, exactly as written.</strong>
            <Example
              rows={[
                ["Evidence", "A table is a good home for a number and a poor home for a caveat."],
                [
                  "Piece 1",
                  <>
                    The table reports averages. <Hit>A table is a good home for a number and a poor home for a caveat.</Hit>
                  </>,
                ],
              ]}
              result="Found in piece 1, word for word"
              ok
            />
          </li>
          <li>
            <strong>If it is not there, look again with small differences ignored:</strong> extra spaces or line breaks, a word split across a
            line, capital letters, curly or straight quotes, and joined letters such as fi.
            <Example
              rows={[
                ["Evidence", "Reading time per page fell by about a quarter."],
                [
                  "Piece 2",
                  <>
                    <Hit>
                      reading time per page fell
                      <br />
                      by about a quarter.
                    </Hit>
                  </>,
                ],
              ]}
              result="Found, after ignoring the line break and the capital"
              ok
            />
          </li>
          <li>
            <strong>The first piece that holds it gives the rank.</strong> Found in piece 2 means rank 2. If no top piece holds it, the question is
            missed, and the rest of what the search returned is checked so the miss can say how far down it was.
          </li>
          <li>
            <strong>The evidence must sit whole inside one piece.</strong>
            <Example
              rows={[
                ["Piece 4 ends", <Half key="a">A table is a good home for a number</Half>],
                [
                  "Piece 5 starts",
                  <>
                    <Half>and a poor home for a caveat.</Half> When a passage
                  </>,
                ],
              ]}
              result="Missed: split across two pieces, so neither holds it"
            />
          </li>
        </ol>
        <Example rows={[["Not a match", "Tables are bad at holding caveats."]]} result="Same meaning, different words. A paraphrase is a miss." />
        <p className="text-fg-muted">
          Coming later: Overlap, which gives partial credit when evidence is split, and an optional AI judge that reads for meaning.
        </p>
      </Section>

      <Section title="The numbers">
        <p className="text-fg-muted">Example: 6 questions, found 1st, 2nd, missed, 1st, 3rd, missed.</p>
        <dl className="flex flex-col gap-3">
          <Number name="Hit rate" tech="Hit@k" what="How many questions were found." sum="4 found / 6 questions = 67%" />
          <Number
            name="Mean reciprocal rank"
            tech="MRR"
            what="How high the answers came back. 1st scores 1, 2nd scores 1/2, 3rd scores 1/3, a miss scores 0. Then take the average. 1.00 is perfect."
            sum="(1 + 1/2 + 0 + 1 + 1/3 + 0) / 6 = 0.47"
          />
          <Number name="Average rank when found" tech="mean rank" what="The average place of the found answers. Lower is better." sum="(1 + 2 + 1 + 3) / 4 = 1.8" />
          <Number
            name="Middle rank when found"
            tech="median rank"
            what="The middle place of the found answers. One very low answer does not move it."
            sum="1, 1, 2, 3, so the middle is 1"
          />
          <Number
            name="Evidence found"
            tech="recall at k"
            what="Shown only when a question has more than one piece of evidence: how many of them came back."
          />
          <Number name="By tag" what="The hit rate for each kind of question, such as table rows and sentences." />
        </dl>
      </Section>

      <Section title="When a question misses">
        <p>
          Open <strong>Why did this miss?</strong> on the question. It follows the evidence through Parse, Clean, Chunk, the search and the pieces
          checked, and stops at the step that lost it. That step tells you what to change: a step on Build, or the search settings.
        </p>
      </Section>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 text-sm text-fg">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Hit({ children }: { children: ReactNode }) {
  return <mark className="rounded-[3px] bg-kept px-[2px] text-kept-text">{children}</mark>
}

function Half({ children }: { children: ReactNode }) {
  return <mark className="rounded-[3px] bg-removed px-[2px] text-removed-text">{children}</mark>
}

function Example({ rows, result, ok = false }: { rows: [string, ReactNode][]; result: string; ok?: boolean }) {
  return (
    <div className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 rounded-panel bg-surface-elevated p-3">
      {rows.map(([label, text]) => (
        <div key={label} className="contents">
          <span className="text-xs text-fg-muted">{label}</span>
          <span className="font-serif text-sm break-words">{text}</span>
        </div>
      ))}
      <span className={ok ? "col-span-2 text-xs font-semibold text-kept-text" : "col-span-2 text-xs font-semibold text-removed-mark"}>
        {ok ? "✓" : "✕"} {result}
      </span>
    </div>
  )
}

function Number({ name, tech, what, sum }: { name: string; tech?: string; what: string; sum?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-hairline pt-3">
      <dt className="font-semibold">
        {name} {tech ? <span className="font-normal text-fg-muted">({tech})</span> : null}
      </dt>
      <dd className="m-0 text-fg-muted">{what}</dd>
      {sum ? <dd className="m-0 self-start rounded-control bg-surface-elevated px-2 py-1 font-mono text-xs text-fg tabular-nums">{sum}</dd> : null}
    </div>
  )
}
