# Business Prospects

## 1. Business conclusion

The strongest first business is **not** “another mass-market Poke clone.” It is:

> An open-source, deployable private iMessage agent foundation for developers and teams, with paid setup, managed private instances, and premium skills.

That path fits the technical reality of Codex credentials, private repositories, iMessage identity, and per-deployment infrastructure. It also creates a credible wedge before attempting a public multi-tenant consumer product.

## 2. Market evidence

Poke provides useful evidence that messaging is a compelling agent interface:

- TechCrunch reported on June 4, 2026 that Poke became the first stand-alone AI agent approved for Apple Messages for Business and had relayed roughly 100 million messages after launching in March.
- The same report described a 10-person company, $25 million raised in total, and a $300 million post-money valuation at that time.
- In July 2026, Cognition acquired the company behind Poke. Reporting emphasized Poke’s conversational interaction style, memory, and ability to coordinate work as strategically valuable to Devin.
- Acquisition reporting also said Poke was expensive to operate despite strong usage. That is a warning against copying a subsidized consumer-agent model without disciplined routing, infrastructure, and monetization.

Sources:

- <https://techcrunch.com/2026/06/04/apple-approves-poke-as-the-first-ai-agent-on-its-messages-for-business-platform/>
- <https://finance.yahoo.com/technology/ai/articles/why-cognition-bought-poke-ai-180732638.html>
- <https://www.ithome.com.tw/news/177650>

This boilerplate uses standard Photon Spectrum iMessage infrastructure. It must not imply Apple Messages for Business approval or equivalence.

## 3. Customer segments

### Segment A: developer-founders

Needs:

- Private agent over iMessage.
- Repository and research workflows.
- Full control over data and prompts.
- A deployable starting point rather than a platform lock-in.

Offer:

- Open-source core.
- Paid “deployed in your accounts” onboarding.
- Curated developer skill packs.

### Segment B: agencies and consultants

Needs:

- Repeatable private-agent installations for clients.
- Clear architecture/security documentation.
- White-label prompts and skills.
- Support for custom connectors.

Offer:

- Commercial deployment toolkit.
- Implementation support.
- Reusable vertical skill bundles.

### Segment C: small technical teams

Needs:

- Shared agent for repository triage, release coordination, and internal operations.
- Team allowlists and approvals.
- Auditability and private infrastructure.

Offer after v1:

- Managed private instance.
- Team roles and shared workspaces.
- Support/SLA and compliance options.

### Segment D: platform ecosystem

Photon, Supermemory, Railway, and agent-tool vendors benefit when developers have a complete reference implementation. Partnerships, co-marketing, and certified templates can reduce customer acquisition cost.

## 4. Differentiation

| Dimension | Boilerplate position |
|---|---|
| Ownership | Runs in the user’s own accounts and repository |
| Interface | Native iMessage through Photon Spectrum |
| Runtime | Codex-backed execution, not only chat completion |
| Reliability | Queue, cancellation, idempotency, restart recovery documented from day one |
| Memory | Explicit split between operational database and semantic memory |
| Security | Sender authorization and approvals in code |
| Extensibility | Markdown prompts, AGENTS.md, and Codex skills |
| Deployment | One Railway project plus transparent auth enrollment |
| Documentation | File-level implementation plan and primary Markdown sources |

The moat is not the base model. It is the complete, trustworthy interaction and deployment system around the model.

## 5. Product ladder

### Free: open-source core

- Full private single-owner starter.
- Local and Railway deployment.
- Core prompts and skills.
- Community support.

Purpose: distribution, trust, ecosystem, and proof of implementation quality.

### Paid service 1: setup and customization

- Install into customer-owned Photon, Railway, Supermemory, and OpenAI/ChatGPT accounts.
- Configure identity, repos, prompts, and initial skills.
- Fixed-price onboarding or implementation package.

### Paid service 2: managed private instance

- Dedicated deployment per customer.
- Backups, updates, monitoring, credential rotation, and support.
- Subscription priced by service tier plus pass-through provider costs.

### Paid service 3: skill packs

Examples:

- GitHub engineering manager.
- Release and incident coordinator.
- Founder research assistant.
- Sales follow-up drafter with confirmations.
- Travel planner with approved booking handoff.

Skills involving external mutations require reviewed connectors and confirmation policies.

### Paid service 4: enterprise/team edition

Later:

- Team identity and roles.
- Audit exports.
- SSO/operator controls.
- Per-workspace credentials.
- Regional deployments and retention controls.
- SLA and security review.

## 6. Pricing hypotheses

These are hypotheses to test, not fixed recommendations:

- Open-source: free.
- Assisted deployment: one-time implementation fee based on custom integrations.
- Managed private individual instance: subscription plus provider pass-through.
- Team instance: base platform fee plus active users, workspaces, or task volume.
- Premium skills: one-time license, subscription, or bundled with managed service.

Do not hide provider costs. The customer may pay separately for Photon, Railway, Supermemory, and OpenAI/API usage or ChatGPT entitlement.

## 7. Cost structure

Main components:

1. **Photon:** plan and line costs vary by shared versus dedicated line and group requirements.
2. **Railway:** application service, PostgreSQL, and persistent volume.
3. **Supermemory:** free/pro/usage-based memory operations.
4. **OpenAI:** ChatGPT entitlement in login mode or token-based API cost in API-key mode.
5. **Support:** deployment, provider auth, failed skills, and third-party API changes.

Account-aware model selection is economically important. Track cost per successfully completed task for the owner's deployment-wide selection; do not introduce request-complexity routing without a separate product decision.

## 8. Go-to-market

### Launch asset

A polished GitHub template with:

- One clear architecture diagram.
- A 5–10 minute first-deploy video.
- A “text your repository” demonstration.
- Screenshots of interruption, approval, and memory deletion—not only a happy-path answer.
- Primary docs index for coding agents.

### Distribution

- GitHub template and release posts.
- Hacker News and developer communities.
- X/YouTube build demonstrations.
- Photon, Railway, Supermemory, and Codex ecosystem partnerships.
- Example forks for developer, founder, and team workflows.

### Content themes

- Why messaging is a better interface for some agents.
- How to make an iMessage agent survive interruptions and retries.
- ChatGPT login in private cloud deployments without pretending it is OAuth.
- Operational database versus semantic memory.
- Account-aware model selection and unit economics.
- Security boundaries for text-triggered coding agents.

## 9. Activation funnel

```text
Repository visit
  → Deploy/fork
  → Provider credentials configured
  → Codex enrolled
  → First authorized iMessage
  → First direct answer
  → First delegated task completed
  → First memory recalled
  → Weekly repeated use
```

Instrument drop-off at each step. The biggest likely friction is provider-account setup and Codex enrollment, so the documentation and readiness diagnostics are core product features.

## 10. North-star and supporting metrics

**North-star:** successfully completed owner tasks per active deployment per week.

Supporting:

- Deployment activation rate.
- Time to first successful message.
- Time to first delegated task.
- Seven-day active deployments.
- Task success and user correction rate.
- Median first acknowledgement and final latency.
- Cost per successful task.
- Percentage of turns using each model profile.
- Memory helpfulness and deletion rates.
- Support tickets per deployment.

## 11. Strategic risks

### Authentication and policy

ChatGPT login behavior, Codex SDK support, entitlement rules, and programmatic-use guidance may change. Mitigation: pin versions, use official docs, maintain API-key/enterprise path, and avoid public shared credentials.

### Provider dependency

Photon line behavior, quotas, plan capabilities, or pricing can change. Mitigation: keep native transport boundaries and document a future provider adapter rather than hiding Spectrum now.

### Consumer-agent economics

Long, proactive, multi-tool sessions can be expensive. Mitigation: deterministic routing, task limits, model profiles, status budgets, and per-task accounting.

### Security and reputation

A text-triggered code agent can delete data or leak secrets if built casually. Mitigation: private single-owner v1, code authorization, restricted environment, sandbox, approvals, and an explicit threat model.

### Support burden

OAuth/device auth, provider accounts, phone routing, and third-party API changes create support load. Mitigation: readiness diagnostics, one-command checks, managed onboarding, and narrowly supported defaults.

### Competitive copying

The source is open. Defensibility comes from brand, documentation quality, maintained integrations, deployment operations, premium skills, and customer trust—not obscurity.

## 12. Recommended sequence

1. Publish a reliable open-source private starter.
2. Offer paid assisted deployments to learn real setup friction.
3. Productize the most repeated skills and diagnostics.
4. Launch managed private instances once update/backup/auth operations are automated.
5. Add team roles only after security and credential architecture is proven.
6. Consider a consumer product only with evidence that acquisition, retention, and unit economics justify a different multi-tenant architecture.

## 13. Business validation experiments

- Ten developer interviews using the actual deployment flow.
- Five assisted installations; measure time and failure causes.
- Compare “text your repo” versus generic life-assistant positioning.
- Track whether users repeat delegated tasks after the novelty period.
- Test willingness to pay for managed operation versus free self-hosting.
- Measure which skill packs produce weekly recurring value.
- Compare Luna-centered routing with Terra-centered routing on task success and cost.

## 14. What not to claim

- “Official Apple AI agent.”
- “Apple Messages for Business” unless separately approved.
- “Zero setup.”
- “Sign in with ChatGPT” as a public end-user OAuth flow.
- “Fully autonomous” when approvals are required.
- “Private” without explaining the third-party providers processing data.
- “Poke clone” in a way that suggests copied proprietary technology or affiliation.
