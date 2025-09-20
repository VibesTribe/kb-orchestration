# Vibeflow Product Requirements Document (PRD)

**Version:** 2.0  
**Status:** Final

---

## 1. Executive Summary

Vibeflow is a next-generation, human-in-the-loop AI orchestration system designed to resolve the critical pain points of AI-driven software development. It empowers a single non-technical user to build complex, production-quality applications by providing a cost-effective, observable, and anti-fragile framework.

The system treats AI as a powerful, strategic tool under human control, rather than a fully autonomous agent. By routing tasks to the most efficient online LLM platforms and enforcing strict quality gates, Vibeflow democratizes software development while ensuring projects remain modular, secure, and built with a viable exit strategy.

---

## 2. Vision & Goals

- **Vision:** Democratize software creation by enabling humans to maintain full strategic control over AI-driven development.
- **Core Philosophy:** Human-in-the-Loop, Anti-Fragile, Problem-Driven, Agnostic.
- **Primary Goal:** Provide a complete, end-to-end solution for a non-coder to build their “legacy project” by automating the most costly and unpredictable parts of the development workflow.

---

## 3. Problem Statement

Vibeflow targets several critical issues in today’s AI development landscape:

1. **AI Unpredictability:** Autonomous agents often deviate from their intended tasks, destroying work and wasting resources.
2. **High Cost & Vendor Lock-in:** Monolithic AI platforms and expensive, per-token APIs create financial barriers and limit flexibility.
3. **Poor Observability:** Project progress and agent activity are buried in chat logs, reducing oversight.
4. **Manual Inefficiencies:** Repetitive tasks like copying code or managing files waste time.
5. **Inaccessibility:** Modern AI tools remain complex for non-technical users.

---

## 4. System Architecture & Components

Vibeflow is a distributed, multi-agent system managed by a central **Orchestrator**.

### 4.1 Core Components

- **Orchestrator:** Receives project requests, routes tasks using a live Model Scorecard, manages data flow, enforces quality gates, and tracks agent effort.
- **Dashboard:** Human-facing UI that provides a real-time visual flowchart of project progress, task status, and system health. Includes a comprehensive ROI calculator.
- **Specialized Agents:**
  - **Admin Agent:** Human operator providing strategic input and approvals.
  - **Planning Agent:** Breaks high-level requests into tasks with =95% confidence.
  - **System Architect Agent:** Converts the PRD into a schema-driven, vertical-slice task list (TaskContracts) to prevent scope drift.
  - **Task Agents:** Multimodal LLMs executing coding and web tasks, working in parallel as needed.
  - **Supervisor Agent:** Validates outputs against requirements and acceptance criteria.
  - **Tester Agent:** Runs unit, integration, and security tests.
  - **Task Agent Test Agent:** Handles visual and interactive UI testing.
  - **Analyst Agent:** Tracks metrics (time, cost, tokens, success rates) for the Model Scorecard and ROI calculator.
  - **Documentation Agent:** Maintains project documentation (summaries, pre-mortems, WBS).
  - **Researcher Agent:** Monitors the AI landscape for new tools and improvements.
  - **Maintenance Agent:** Handles system health, automation updates, bug fixes, and secure change rollout.

---

## 5. Functional Requirements

- **F1 (Orchestration):** Orchestrator must route tasks to the best-suited agents and ensure outputs meet TaskContract requirements.
- **F2 (Planning & Architecture):** Planning Agent produces step-by-step plans; System Architect Agent outputs atomic TaskContracts.
- **F3 (Execution):** Task Agents must run in parallel, support multimodal inputs, and respect budget/time caps.
- **F4 (Quality Control):** Supervisor, Tester, and UI Test Agents enforce quality gates before completion.
- **F5 (Analytics & Reporting):** Analyst Agent tracks detailed metrics and maintains the Model Scorecard.
- **F6 (Dashboard & Observability):** Dashboard provides live flowcharts, PES, ROI metrics.
- **F7 (Documentation):** Documentation Agent keeps all docs updated as work progresses.

---

## 6. Non-Functional Requirements

1. **Modularity:** Architecture should allow easy swapping of LLMs and components.
2. **Agnosticism:** Avoid vendor lock-in.
3. **Scalability:** Stateless orchestrator, modular agents for horizontal scaling.
4. **Security:** Secure key management and PR-based testing/approval flow.
5. **Anti-Fragility:** System should fail gracefully; Supervisor and Analyst agents catch and correct errors.

---

## 7. Technology Stack

- **Frontend:** React, Tailwind CSS, shadcn/ui.
- **Backend:** Node.js 20.x, TypeScript, Express.
- **Database:** PostgreSQL.
- **Deployment:** Docker, Google Cloud Run.
- **Version Control:** GitHub.
- **Agent Framework:** Modular adapters for external services.
- **Orchestration:** Custom Supervisor, Orchestrator, Task Agent services.
- **Secret Management:** Google Secret Manager.

---

## 8. Testing & Quality Assurance

- **Test Generation First:** Every coding task must have tests defined before implementation.
- **Definition of Done:** All criteria met, security scans clean, docs updated, budget on track.
- **Coverage Thresholds:** Unit tests =80% (=90% for critical paths); mutation score =65%.
- **“Reqing Ball” Agent:** Audits final implementation against this PRD.
- **“Polisher” Agent:** Provides FANG-level design/implementation feedback.

---

## 9. Observability & Incident Response

- **Tracing:** All operations propagate `trace_id` and `task_id` for end-to-end traceability.
- **Alerting:** Automatic alerts for latency SLO breaches, high error rates, budget thresholds, circuit-breakers.
- **Incident Management:** Formal process with states: OPEN ? MITIGATED ? RCA DUE ? CLOSED.

---

## 10. Environments & Deployment (CI/CD)

- Separate **dev**, **staging**, **prod** environments with isolated secrets and data.
- Pipeline includes linting, testing, security & license scans.
- Staging deploys automatically; production requires manual approval by Admin Agent.
- Infrastructure as Code (e.g., Terraform, Google Cloud Deployment Manager).

---

## 11. Exit Strategy & Compliance

- **Compliance:** GDPR-ready via data minimization, versioned PRDs, traceability.
- **Exit Package:** Includes PRDs, WBS, routing policies, Model Scorecards, test reports, security scans, architecture diagrams, IaC manifests, cost ledgers, and onboarding runbooks.

### Exit Package Checklist

- [ ] Final PRD (this document) and historical snapshots
- [ ] Complete Work Breakdown Structure (WBS)
- [ ] Routing policies (historic and current)
- [ ] 30 & 90-day Model Scorecard data
- [ ] Test and security reports
- [ ] Append-only audit log
- [ ] Infrastructure as Code manifests
- [ ] Full cost & spend ledger
- [ ] Architecture diagrams & data dictionaries
- [ ] Onboarding runbook for new teams

---

## Appendix: Vertical Slice Template

- **Slice Name:** e.g., “Model Scorecard Table (Read-only)”
- **Objective:** A single user can view a paginated, sortable Model Scorecard on the dashboard.
- **Scope:** Backend API endpoint, DB schema, UI component, tests (unit/integration/e2e), telemetry, budget allocation.
- **TaskContracts:** Enumerated TaskContracts with inputs, outputs, acceptance criteria.
- **Gate:** Successful demo script and passing automated end-to-end tests.

---

**Reference:** [Gemini PRD source](https://gemini.google.com/app/5ea86041a975016e)
