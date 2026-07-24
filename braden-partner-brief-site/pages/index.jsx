import Head from "next/head";
import { useEffect } from "react";

const navItems = [
  ["Thesis", "#thesis"],
  ["Role", "#role"],
  ["System", "#system"],
  ["Engine", "#engine"],
  ["Economics", "#economics"],
  ["Next step", "#next"]
];

const creatorStages = [
  "Target",
  "Qualify",
  "Recruit",
  "Contract",
  "Onboard",
  "Launch",
  "Manage",
  "Attribute",
  "Optimize",
  "Retain",
  "Expand"
];

function RuleList({ items, className = "" }) {
  return (
    <ul className={`rule-list ${className}`.trim()}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function SectionHead({ index, title, intro, id, titleId }) {
  return (
    <div className="section-head" id={id}>
      <div>
        <span className="section-index">{index}</span>
        <h2 id={titleId} data-pretext>
          {title}
        </h2>
      </div>
      <p>{intro}</p>
    </div>
  );
}

function TermRow({ label, value, strong = false }) {
  return (
    <div className={`term-row${strong ? " term-row-strong" : ""}`}>
      <span className="term-label">{label}</span>
      <strong className="term-value">{value}</strong>
    </div>
  );
}

function NumberedList({ items }) {
  return (
    <ol className="numbered-list">
      {items.map((item, index) => (
        <li key={item}>
          <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <p>{item}</p>
        </li>
      ))}
    </ol>
  );
}

export default function Home() {
  useEffect(() => {
    const header = document.querySelector(".site-header");
    const anchorLinks = [...document.querySelectorAll(".anchor-link")];
    const observedSections = anchorLinks
      .map((link) => document.querySelector(link.getAttribute("href")))
      .filter(Boolean);

    const updateHeader = () => {
      header?.classList.toggle("is-scrolled", window.scrollY > 8);
    };

    const sectionObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (!visible) return;

        anchorLinks.forEach((link) => {
          const active = link.getAttribute("href") === `#${visible.target.id}`;
          link.classList.toggle("is-active", active);
          if (active) {
            link.setAttribute("aria-current", "location");
          } else {
            link.removeAttribute("aria-current");
          }
        });
      },
      {
        rootMargin: "-18% 0px -68% 0px",
        threshold: [0, 0.15, 0.5]
      }
    );

    observedSections.forEach((section) => sectionObserver.observe(section));
    window.addEventListener("scroll", updateHeader, { passive: true });
    updateHeader();

    let resizeAnimationFrame;
    let relayoutOnResize;
    let disposed = false;

    Promise.all([
      document.fonts.ready,
      import("@chenglou/pretext")
    ])
      .then(([, pretext]) => {
        if (disposed) return;

        const elements = [...document.querySelectorAll("[data-pretext]")];
        const prepared = new Map();

        const prepareElement = (element) => {
          const style = window.getComputedStyle(element);
          prepared.set(
            element,
            pretext.prepare(element.textContent.trim(), style.font)
          );
        };

        const relayout = () => {
          prepared.forEach((handle, element) => {
            const style = window.getComputedStyle(element);
            const lineHeight = Number.parseFloat(style.lineHeight);
            const result = pretext.layout(
              handle,
              element.clientWidth,
              Number.isFinite(lineHeight)
                ? lineHeight
                : Number.parseFloat(style.fontSize) * 1.2
            );
            const nextHeight = `${Math.ceil(result.height)}px`;
            if (
              element.style.getPropertyValue("--pretext-height") !== nextHeight
            ) {
              element.style.setProperty("--pretext-height", nextHeight);
            }
          });
        };

        elements.forEach(prepareElement);
        relayoutOnResize = () => {
          window.cancelAnimationFrame(resizeAnimationFrame);
          resizeAnimationFrame = window.requestAnimationFrame(relayout);
        };
        window.addEventListener("resize", relayoutOnResize, { passive: true });
        relayout();
      })
      .catch(() => {
        // CSS remains the complete fallback if browser text measurement is unavailable.
      });

    return () => {
      disposed = true;
      sectionObserver.disconnect();
      window.cancelAnimationFrame(resizeAnimationFrame);
      if (relayoutOnResize) {
        window.removeEventListener("resize", relayoutOnResize);
      }
      window.removeEventListener("scroll", updateHeader);
    };
  }, []);

  return (
    <>
      <Head>
        <title>Biologix × OVO — Operating Partnership Brief</title>
        <meta
          name="description"
          content="A founder-to-founder operating partnership brief prepared for Braden Lowder."
        />
        <meta name="robots" content="noindex,nofollow,noarchive" />
        <meta
          property="og:title"
          content="Biologix × OVO — Operating Partnership"
        />
        <meta
          property="og:description"
          content="A founder-to-founder brief prepared for Braden Lowder."
        />
        <meta name="theme-color" content="#f7f4ee" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,540&family=Manrope:wght@400;600;800&display=swap"
          rel="stylesheet"
        />
      </Head>

      <header className="site-header">
        <div className="header-shell">
          <a className="wordmark" href="#top" aria-label="Back to the top">
            Biologix × OVO
          </a>
          <nav className="anchor-nav" aria-label="Sections">
            {navItems.map(([label, href]) => (
              <a className="anchor-link" href={href} key={href}>
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main id="top">
        <header className="hero page-shell">
          <p className="eyebrow">
            Founder-to-founder brief · Prepared for Braden Lowder · July 2026
          </p>
          <h1>
            Biologix already has extraordinary demand. This partnership builds
            the company that holds it —{" "}
            <span>and multiplies it.</span>
          </h1>
          <p className="standfirst">
            What you built is rare: real demand, category authority, sourcing
            depth, and a brand people chase — all before the company underneath
            it existed. That is not a flaw. It is proof of how much leverage is
            still on the table. This brief lays out the partnership that installs
            the company layer: one operating partner, one accountable delivery
            team, and one clean set of economics.
          </p>
          <p className="meta-line">
            Discussion framework — not a contract · Unlisted link · Prepared by
            Alex Gunnarsson
          </p>
        </header>

        <div className="page-shell">
          <section className="brief-section" aria-labelledby="thesis-title">
            <SectionHead
              id="thesis"
              titleId="thesis-title"
              index="01 / The thesis"
              title="What you built. What the next stage requires."
              intro="Nothing here is a critique. Demand outran infrastructure because the demand was real."
            />
            <div className="split-panel">
              <article>
                <h3>You built the part that can&apos;t be bought</h3>
                <RuleList
                  items={[
                    "Demand real enough to outrun the infrastructure under it",
                    "Category knowledge deep enough to teach in your sleep",
                    "Sourcing and supplier relationships built on trust",
                    "A founder voice people actually follow",
                    "Checkout rails most peptide brands can’t get — direct PayPal, redundant processors",
                    "PeptidePal — a second strategic asset already in hand",
                    "A Mount Rushmore ambition — build the defining brand, don’t sell it"
                  ]}
                />
              </article>
              <article>
                <h3>The next stage needs the part that must be built</h3>
                <RuleList
                  items={[
                    "Finance you can see weekly, run by professionals",
                    "A creator engine bigger than a handful of active relationships",
                    "Your day back from labels, boxes, and ops calls",
                    "Managers and systems that don’t all route through you",
                    "Analytics that survive a big weekend",
                    "A company that compounds whether or not you touched it today"
                  ]}
                />
              </article>
            </div>
            <blockquote className="pull-quote" data-pretext>
              The missing infrastructure isn&apos;t a weakness. It&apos;s the
              measure of how much is still on the table.
            </blockquote>
          </section>

          <section className="brief-section" aria-labelledby="role-title">
            <SectionHead
              id="role"
              titleId="role-title"
              index="02 / The role"
              title="This is bigger than a CRO."
              intro="A revenue title solves a revenue problem. Biologix has a company-building opportunity."
            />
            <div className="prose-block">
              <p>
                A CRO owns a number inside a company someone else runs. What
                Biologix needs owned is the company layer itself — the operating
                cadence, the finance function, the people architecture, the
                distribution engine, and the discipline about where cash goes
                next. That is an Operating Partner: someone who builds enterprise
                value alongside the founder, with skin in the outcome, not a
                salary against a quota.
              </p>
              <RuleList
                className="labeled-list"
                items={[
                  "Operating architecture — the weekly rhythm the whole company runs on.",
                  "Finance visibility — plans, budgets, and capital-allocation rules both owners can see.",
                  "People architecture — recruiting, managers, vendors, and real accountability.",
                  "Distribution — the creator engine, lifecycle, analytics, and partnerships.",
                  "Controlled scaling — growth sequenced so the company gets stronger as it gets bigger."
                ]}
              />
              <p>
                On the third call, Braden floated a lighter start — run the
                affiliate back end alone and watch the numbers. This brief takes
                the other lane, the one the call kept returning to: one operating
                partner across the whole company layer. His verdict on the title
                was shorter than this sentence.
              </p>
              <p className="closing-line">
                Braden stays the founder. Alex builds the company around the
                founder.
              </p>
            </div>
            <blockquote className="pull-quote" data-pretext>
              &ldquo;I think Operating Partner&apos;s fire.&rdquo; — Braden,
              third call, July 23
            </blockquote>
          </section>

          <section
            className="brief-section print-break"
            aria-labelledby="map-title"
          >
            <SectionHead
              titleId="map-title"
              index="03 / The map"
              title="Who owns what."
              intro="Clean lanes. No overlap, no ambiguity, no shadow authority."
            />
            <div className="ownership-map">
              <article>
                <p className="term-label">Braden keeps</p>
                <RuleList
                  items={[
                    "Founder vision and the public voice",
                    "Product and category knowledge",
                    "Sourcing and supplier relationships",
                    "Inventory, fulfillment, shipping, and 3PL decisions",
                    "Final product and brand calls within the agreed operating plan"
                  ]}
                />
              </article>
              <article>
                <p className="term-label">Alex owns</p>
                <RuleList
                  items={[
                    "Operating architecture and the weekly leadership cadence",
                    "Finance visibility, budgets, and capital-allocation process",
                    "People: recruiting, managers, vendors, accountability",
                    "The full creator engine — recruiting through payouts and reporting",
                    "Lifecycle, analytics, and growth coordination across vendors",
                    "Partnerships, expansion, retreats, and controlled scaling"
                  ]}
                />
              </article>
              <article>
                <p className="term-label">OVO installs</p>
                <RuleList
                  items={[
                    "Creator-manager pods",
                    "Recruiting and outbound capacity",
                    "Central QA, claims workflow, payout and data operations",
                    "Content coordination, tooling, and training",
                    "Replacement coverage — no single point of failure",
                    "Management of every OVO person deployed to Biologix"
                  ]}
                />
              </article>
            </div>
            <div className="sub-block">
              <p className="term-label">Where Connor fits</p>
              <p>
                Connor keeps his lane: he stays a manager, with the
                relationships he already runs — Creators Corner first among
                them. Braden&apos;s ask was explicit: work together, neither
                stepping on the other&apos;s toes. Alex builds the architecture,
                standards, and analytics every manager plugs into. Connor plugs
                in first, not last.
              </p>
            </div>
            <p className="footnote">
              OVO and Alex do not own product, sourcing, inventory, fulfillment,
              or 3PL. Those stay with the founder.
            </p>
          </section>

          <section className="brief-section" aria-labelledby="system-title">
            <SectionHead
              id="system"
              titleId="system-title"
              index="04 / The system"
              title="What actually gets installed."
              intro="Not advice. Installed systems with owners, cadence, and documentation."
            />
            <NumberedList
              items={[
                "Weekly executive operating review — one meeting where the whole company is visible and decided.",
                "A professional finance function — weekly cash dashboard, monthly close, jointly approved budgets.",
                "People architecture — the managers, roles, and accountability the next stage requires.",
                "The creator engine — recruiting, onboarding, contracts workflow, training, attribution, payouts, reporting.",
                "Lifecycle and retention — the membership tiers Braden and Connor drafted, fused with the subscribe-and-save engine mapped on the July 23 call, wired into email, SMS, and the affiliate system.",
                "Partnership and expansion planning — sequenced, budgeted, and reviewed before money moves.",
                "Documentation and SOPs — so the company runs on systems, not memory."
              ]}
            />
          </section>

          <section className="brief-section" aria-labelledby="engine-title">
            <SectionHead
              id="engine"
              titleId="engine-title"
              index="05 / The engine"
              title="A system, not a list of introductions."
              intro="Introductions are a favor. This is a machine with eleven stages and named owners."
            />
            <ol className="pipeline" aria-label="Creator operating pipeline">
              {creatorStages.map((stage, index) => (
                <li key={stage}>
                  <span className="pipeline-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{stage}</span>
                </li>
              ))}
            </ol>
            <div className="sub-block">
              <h3>How the leverage works</h3>
              <RuleList
                items={[
                  "Alex directs the operating system and its standards.",
                  "OVO managers will own creator portfolios — ten to fifteen relationships each, managed daily.",
                  "Braden’s affiliate tree — managers, affiliates, sub-affiliates — becomes visible in one system: every branch attributed, every payout traceable.",
                  "Central QA, data, and payout operations keep the program independent of any one manager.",
                  "Capacity grows by adding pods — not by piling direct reports onto the founder."
                ]}
              />
              <p className="closing-line">
                Braden said it on the third call: this is his first brand, and he
                doesn&apos;t want to run this layer. He shouldn&apos;t have to.
                This is the machine OVO will install — and the tree he described
                is exactly what it&apos;s built to run.
              </p>
            </div>
          </section>

          <section className="brief-section" aria-labelledby="finance-title">
            <SectionHead
              titleId="finance-title"
              index="06 / The numbers you can see"
              title="From heroic bookkeeping to a finance function."
              intro="The current setup got the company here. It was never meant to carry the next stage."
            />
            <div className="prose-block">
              <p>
                Biologix&apos;s books are carried today by family loyalty —
                capably, and at real personal cost. Step one honors that: capture
                the working knowledge, and fully relieve a role its current
                holder is — in Braden&apos;s own word — &ldquo;begging&rdquo; to
                hand off. Then the company gets the finance function its scale
                deserves.
              </p>
              <NumberedList
                items={[
                  "Independent bookkeeping and controller coverage — professionals whose only job is the books.",
                  "Full reconciliation — settled cash, refunds, processor balances, inventory obligations, payouts, liabilities, reserves.",
                  "A weekly cash dashboard and a real monthly close.",
                  "Jointly approved budgets and capital-allocation rules.",
                  "Read-only visibility for both owners — nobody operates blind.",
                  "A disinterested company approver reviews OVO invoices as related-party expenses."
                ]}
              />
              <p className="highlight-line">
                Alex builds the decision system. An independent finance operator
                executes and reconciles it. Material capital decisions are agreed,
                visible, and documented.
              </p>
            </div>
          </section>

          <section className="brief-section print-break" aria-labelledby="month-one-title">
            <SectionHead
              titleId="month-one-title"
              index="07 / Month one"
              title="Operating Transition & Launch."
              intro="One package. One price. Two workstreams running simultaneously from day one."
            />
            <div className="term-table">
              <TermRow
                label="Month 1 · Prepaid"
                value="$30,000 — Operating Transition & Launch"
                strong
              />
            </div>
            <p className="term-status">
              New in this brief — proposed price, not discussed on the calls
            </p>
            <div className="split-panel compact-panel">
              <article>
                <h3>Workstream A — Operating foundation</h3>
                <RuleList
                  items={[
                    "Finance transition and capture of current working knowledge",
                    "Weekly operating cadence installed",
                    "Owner-visible cash dashboard stood up",
                    "The 90-day roadmap and capital plan drafted and agreed"
                  ]}
                />
              </article>
              <article>
                <h3>Workstream B — First pod deployed</h3>
                <RuleList
                  items={[
                    "The first OVO operating pod goes live in week one",
                    "Existing creator relationships onboarded to the system",
                    "Contracts workflow, attribution, and reporting switched on",
                    "Recruiting pipeline opened against the target list"
                  ]}
                />
              </article>
            </div>
            <p className="closing-line below-panel">
              Nothing waits for an audit to finish. Once the agreement is signed,
              the foundation and the engine start the same week.
            </p>
          </section>

          <section className="brief-section" aria-labelledby="ongoing-title">
            <SectionHead
              titleId="ongoing-title"
              index="08 / Ongoing"
              title="One accountable managed function."
              intro="Biologix buys outcomes and capacity — not a pile of individual hires to recruit and supervise."
            />
            <div className="term-table">
              <TermRow
                label="Month 2 onward · Prepaid"
                value="$20,000 per month — OVO managed operating pod"
                strong
              />
              <TermRow
                label="Included capacity"
                value="First 25 active managed creator relationships"
              />
              <TermRow
                label="Expansion"
                value="≈ $10,000 capacity pod per additional 15 active creators"
              />
            </div>
            <p className="term-status">
              New in this brief — proposed structure, pricing, and capacity
              thresholds, not discussed on the calls
            </p>
            <RuleList
              className="below-panel"
              items={[
                "Recruiting, management, training, SOPs, tooling, career paths, and replacement coverage are OVO’s to build and run — delivered inside the fee, not billed as extras.",
                "One accountable function replaces separately recruiting and supervising multiple individual hires.",
                "Capacity expands or contracts as the active creator roster changes.",
                "Biologix sets business priorities and outcomes. OVO manages its personnel and delivery.",
                "If a role truly belongs inside Biologix over time, it converts under a transparent agreed process."
              ]}
            />
          </section>

          <section className="brief-section" aria-labelledby="ecosystem-title">
            <SectionHead
              titleId="ecosystem-title"
              index="09 / The ecosystem"
              title="Retreats are strategy, not parties."
              intro="The creator ecosystem is a moat competitors can’t copy with a coupon code."
            />
            <div className="prose-block">
              <p>
                Retreats and creator experiences do five jobs at once: recruiting
                gravity, retention, relationship density, founder and creator
                content, and a premium community that attracts partnerships. Miami
                is the natural stage for it — and it&apos;s already part of the
                plan we&apos;ve talked about.
              </p>
              <p className="closing-line">Scoped separately, on purpose:</p>
              <RuleList
                items={[
                  "Retreats and creator events",
                  "Production-heavy content weekends",
                  "Major custom software builds",
                  "Permanent direct-hire recruiting",
                  "Other projects outside pod capacity"
                ]}
              />
              <p>
                Each gets a preapproved written scope with a transparent budget
                and production fee — approved before work starts, never absorbed
                invisibly into the monthly base.
              </p>
            </div>
          </section>

          <section
            className="brief-section print-break"
            aria-labelledby="economics-title"
          >
            <SectionHead
              id="economics"
              titleId="economics-title"
              index="10 / The economics"
              title="One partnership. Three clean layers."
              intro="Ownership for building enterprise value. Fees only for delivery capacity actually used."
            />
            <div className="layer-stack">
              <article className="layer-panel">
                <p className="term-label">Layer 01 — Owner</p>
                <h3>Operating Partner ownership</h3>
                <div className="term-table">
                  <TermRow
                    label="Ownership"
                    value="30% — discussed July 23, not yet agreed"
                  />
                  <TermRow
                    label="Monthly owner cash"
                    value="70 / 30 split of defined Excess Cash"
                  />
                </div>
                <p className="term-status">
                  Ownership: discussed on the July 23 call — Braden is taking
                  time. Owner-cash split: new in this brief
                </p>
                <p>
                  Thirty percent is the number from the July 23 call — Braden
                  called it &ldquo;not crazy&rdquo; and asked for a day or two,
                  so it stands as discussed, not agreed. Everything that gives
                  the number its meaning — the fully-diluted definition, vesting,
                  repurchase, and activation conditions — is proposed here for
                  the definitive documents. While Alex is actively operating,
                  monthly Excess Cash — what remains after company obligations
                  and the agreed reserve — would be split 70% Braden, 30% Alex.
                  That split is also new in this brief.
                </p>
              </article>
              <article className="layer-panel">
                <p className="term-label">Layer 02 — Delivery</p>
                <h3>The OVO managed service</h3>
                <div className="term-table">
                  <TermRow
                    label="Month 1"
                    value="$30,000 — Operating Transition & Launch"
                  />
                  <TermRow
                    label="Month 2 onward"
                    value="$20,000 / month — managed pod, first 25 active creators"
                  />
                  <TermRow
                    label="Expansion"
                    value="≈ $10,000 per additional 15 active creators"
                  />
                </div>
                <p className="term-status">
                  New in this brief — proposed pricing, not discussed on the
                  calls
                </p>
                <p>
                  Biologix pays OVO for the managed team and operating capacity it
                  actually uses — one accountable function, prepaid monthly,
                  scaled by pods.
                </p>
              </article>
              <article className="layer-panel">
                <p className="term-label">Layer 03 — Exceptional</p>
                <h3>Separately scoped projects</h3>
                <div className="term-table">
                  <TermRow
                    label="Retreats · Content productions · Major software · Direct-hire recruiting"
                    value="Preapproved written scope, each time"
                  />
                </div>
                <p className="term-status">
                  New in this brief — proposed process
                </p>
                <p>
                  Only truly separate projects carry a separate scope — reviewed
                  and approved in writing before any work begins.
                </p>
              </article>
            </div>
            <p className="framework-note">
              Discussion framework only. One number on this page was discussed
              on a call — the 30% ownership, still awaiting Braden&apos;s answer.
              Every fee, capacity threshold, the owner-cash split, vesting,
              repurchase, and activation conditions appear here for the first
              time. Final economics, authority, vesting, scope, and activation
              require definitive agreements and professional review.
            </p>
          </section>

          <section className="brief-section" aria-labelledby="commitment-title">
            <SectionHead
              titleId="commitment-title"
              index="11 / The commitment"
              title="Primary build, honest terms."
              intro="Measured in owned outcomes and response windows — not vague hours."
            />
            <blockquote className="pull-quote" data-pretext>
              Biologix becomes Alex&apos;s primary operating-partner build — not
              his exclusive employer.
            </blockquote>
            <div className="prose-block">
              <p>
                Alex restructures his consulting engagements around this build —
                &ldquo;I will restructure all of that around this,&rdquo; in his
                words from the call — and personally owns the decisions that
                matter: the operating cadence, capital planning, and leadership.
                He continues to own and lead OVO — because OVO is the platform,
                team, systems, and network being deployed here — and may take on
                noncompetitive work. What Biologix gets is priority: first claim
                on Alex&apos;s attention and on the capacity this brief proposes.
              </p>
              <p className="term-label">The operating commitment</p>
              <RuleList
                items={[
                  "One weekly executive operating review, led personally",
                  "Direct ownership of the 90-day roadmap and capital plan",
                  "Daily async access for escalations and decisions",
                  "Defined on-site, launch, and retreat blocks",
                  "Measurable outcomes and agreed response windows — instead of a vague “full time”"
                ]}
              />
            </div>
          </section>

          <section className="brief-section" aria-labelledby="next-title">
            <SectionHead
              id="next"
              titleId="next-title"
              index="12 / Next step"
              title="The first 90 days."
              intro="A fast transition from founder-dependent momentum to a managed operating rhythm."
            />
            <div className="timeline-panel">
              <div>
                <span className="term-label">Days 1–30</span>
                <p>
                  Foundation and launch — finance transition begins, cadence
                  installed, first pod live, roadmap agreed.
                </p>
              </div>
              <div>
                <span className="term-label">Days 31–60</span>
                <p>
                  Control and momentum — monthly close running, creator roster
                  onboarded, recruiting pipeline producing.
                </p>
              </div>
              <div>
                <span className="term-label">Days 61–90</span>
                <p>
                  Scale decisions — capacity review, first expansion pod if the
                  roster supports it, retreat and partnership calendar set.
                </p>
              </div>
            </div>
            <div className="close-block">
              <p>
                You said we&apos;ve got to get started ASAP. This is what starting
                looks like. Read it twice, mark up anything, and let&apos;s sit
                down — Miami works — and turn this framework into definitive
                documents.
              </p>
              <a href="mailto:alex@ovotalent.com">alex@ovotalent.com</a>
            </div>
          </section>
        </div>
      </main>

      <footer className="site-footer">
        <div className="page-shell">
          <p>
            Private brief · Prepared for Braden Lowder · Not indexed · Not an
            offer or a contract
          </p>
          <p>Alex Gunnarsson · OVO · July 2026</p>
        </div>
      </footer>
    </>
  );
}
