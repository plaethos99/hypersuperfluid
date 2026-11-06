---
name: erp-customization
description: Build custom workflows, approvals, automations, custom fields, forms and scripts to a client's requirement in any ERP (Odoo, NetSuite, Oracle Fusion/EBS/JDE/PeopleSoft, SAP S/4HANA and Business One, Dynamics 365, Salesforce, Workday, ERPNext, Zoho, QuickBooks, Xero, Sage, Infor, Epicor, Acumatica, IFS, Tally). Load it whenever a task asks for a workflow, approval, automation, notification, custom field or object, form change, validation, script or integration.
---

# Building custom workflows and changes

## Method (every ERP)

1. **Pin down the requirement** in one short spec: trigger (record and event), conditions, steps or approvers
   (by role, amount, department), actions (field updates, emails, tasks, record creation), exceptions (rejection,
   escalation, delegation, timeouts) and who maintains it. Ask only what you cannot see in the system.
2. **Pick the most native tool**, in this order: configuration (settings, approval setup) > the ERP's no-code
   workflow or automation builder > low-code (formulas, expressions, Groovy, Deluge) > code (scripts, extensions,
   custom modules). Native configuration survives upgrades; code needs a developer to maintain it.
3. **Look it up before building**: call `doc_search` with the ERP and the tool name (queries below), open the exact
   page with `fetch_page`, and follow the vendor's current steps and limits. Never guess menu paths.
4. **Build in a sandbox or test instance first**, never straight in production. Name everything clearly (prefix
   with the client or the purpose), and keep it inactive until tested.
5. **Test with sample records**: the happy path, each condition branch, rejection, a missing approver, and a record
   that must NOT trigger it. Show the person the results.
6. **Document** in the working folder: the spec, what was configured where (menu paths, record names, script ids),
   test results, and how to switch it off.
7. **Move to production** with the ERP's own migration tool (listed below), activate, confirm with the person.
   Activating or deploying in a live system is a final step: confirm first.

## Where each ERP builds them (and what to search)

| ERP | No-code / configuration | Low-code / code | Move between instances | `doc_search` queries |
|---|---|---|---|---|
| Odoo | Studio: fields, views, **automation rules** (on create/update/time/webhook), approval rules on buttons; Approvals app; Settings > Technical > Automation Rules, Scheduled Actions (developer mode) | Server actions (Python code), custom modules (Python/XML) | Odoo.sh branches, module install; Studio export/import | "studio automation rules", "approval rules", "server actions", "scheduled actions" |
| NetSuite | **SuiteFlow** (Customization > Workflow > Workflows > New): states, transitions, actions; approval routing (Setup > Accounting > Approval Routing); custom fields/records/forms (Customization > Lists, Records & Fields) | SuiteScript 2.x (user event, client, scheduled, map/reduce, Suitelet, RESTlet), workflow action scripts | SuiteCloud Development Framework (SDF), Copy to Account, bundles | "suiteflow workflow", "approval routing", "suitescript user event", "SDF deploy" |
| Oracle Fusion | Approval rules: FSM task *Manage Approval Rules / Manage Task Configurations for Financials* (BPM Worklist); Transaction Console; flexfields (Manage Descriptive Flexfields); **Sandboxes** + Page Composer, Structure | Application Composer + Groovy (where available), Visual Builder extensions, OIC integrations, BI Publisher/OTBI | Configuration packages (FSM export/import), sandbox publish | "approval rules", "manage task configurations", "sandboxes page composer", "descriptive flexfields" |
| Oracle EBS / JDE / PeopleSoft | EBS: AME approval rules, Oracle Workflow Builder, personalization; JDE: Orchestrator Studio, workflow approvals, form extensions; PeopleSoft: Approval Workflow Engine (AWE), Page and Field Configurator | EBS: PL/SQL, Forms/OAF extensions; JDE: business functions; PeopleSoft: PeopleCode, Event Mapping | EBS patches/FNDLOAD; JDE OMW projects; PeopleSoft projects (App Designer) | "AME approval", "orchestrator studio", "approval workflow engine" |
| SAP S/4HANA | **Flexible Workflow** (Fiori: Manage Workflows for Purchase Requisitions/Orders, Supplier Invoices, Journal Entries ...); Key User Extensibility: Custom Fields, Custom Logic, Custom Business Objects; Output management | SAP Business Workflow (SWDD), BAdIs, ABAP Cloud / developer extensibility, SAP Build Process Automation (BTP) | Transports (customizing/workbench), Export/Import Software Collection in public cloud | "flexible workflow", "custom fields and logic", "manage workflows supplier invoices" |
| SAP Business One | Approval Procedures (Administration > Approval Procedures > Stages, Templates); user-defined fields/tables (UDF/UDT/UDO); Formatted Search; alerts | SDK / DI API, Service Layer, B1 Usability Package (third-party) | Copy Express, UDO registration per company | "approval procedures", "user-defined fields", "formatted search" |
| Dynamics 365 Business Central | **Workflows** page (from templates: purchase/sales approvals, vendor/customer/item approvals), Approval User Setup, Workflow User Groups; personalisation; Power Automate approvals | AL extensions (VS Code): table/page extensions, events | Extension (.app) publishing, environment copy | "workflow purchase document approval", "approval user setup", "power automate business central" |
| Dynamics 365 Finance & Operations | Workflow editor (Module > Setup > ... workflows: purchase requisitions, vendor invoices, journals); personalisation; business events + Power Automate | X++ extensions (Chain of Command, event handlers), data entities | LCS/Power Platform deployable packages, DMF data packages | "workflow configuration", "business events", "extension chain of command", "data management import" |
| Power Automate | Cloud flows (automated, scheduled, instant), Approvals connector, Dataverse triggers | Expressions, custom connectors, desktop flows (RPA) | Solutions (managed/unmanaged) | "approvals connector", "dataverse trigger", "solutions export" |
| Salesforce | **Flow Builder** (record-triggered, screen, scheduled, autolaunched), **Approval Processes** / Flow Approval Orchestration, validation rules, Object Manager fields/objects, Dynamic Forms | Apex triggers/classes, LWC | Change sets, Salesforce CLI/DevOps Center | "record-triggered flow", "approval process", "validation rules", "change sets" |
| Workday | Business Process Framework (*Edit Business Process*: approvals, conditions, notifications, sub-processes), custom fields, calculated fields, condition rules | Workday Extend, Studio/EIB integrations | Tenant configuration migration (Object Transporter) | Docs need a Workday Community login: ask the person to open them |
| ERPNext / Frappe | **Workflow** doctype (states, transitions, roles), Customize Form, Custom Field, Notification, Assignment Rule, Auto Repeat, Web Form | Server Script, Client Script (JS), custom app (Python) | Export customizations (fixtures), app install | "workflow", "customize form", "server script", "notification" |
| Zoho Books / Zoho | Settings > Automation > **Workflow Rules** (email alerts, field updates, webhooks), Approvals, custom fields/modules | Custom functions (Deluge) | Sandbox (Zoho One), manual re-creation | "workflow rules", "custom functions deluge", "approvals" |
| QuickBooks Online | Custom fields, **Workflows** (Advanced: approvals, reminders), rules for bank feeds | Apps/API (Intuit Developer) | None; recreate per company | search the vendor site: quickbooks.intuit.com/learn-support |
| Xero | Approvals by user roles, repeating invoices, bank rules | Apps / API | None | search central.xero.com |
| Sage Intacct / X3 | Intacct: approvals (purchasing, AP, expenses), Smart Rules, Smart Events, custom fields/objects (Platform Services); X3: workflow rules (GESAWA), parameters | Intacct: Platform Services/Smart Events scripts; X3: 4GL | Intacct: sandbox + Configuration Services; X3: patch files | search the vendor site (sage.com, intacct.com) |
| Infor CloudSuite | ION Workflow, Mongoose form personalisation (SyteLine/CSI), M3/LN workflows | Mongoose IDOs, ION API | ION/Mongoose packages | "ION workflow", "form personalization" |
| Epicor Kinetic | BPM: method/data/in-transaction directives, Application Studio layers, UD tables/fields | BPM custom code (C#), functions | Solution Workbench | docs need EpicCare login |
| Acumatica | Customization Project: workflows (states, actions), Business Events, Automation Schedules, generic inquiries | C# graph extensions | Customization packages | search help.acumatica.com |
| IFS Cloud | Workflow Designer (BPMN), Custom fields/entities/events, page designer | Custom events (PL/SQL) | Configuration packages | search docs.ifs.com |
| Tally Prime | Voucher types, user roles; no workflow builder | TDL (Tally Definition Language) customization | TDL files | "TDL", "voucher type configuration" |

## Hand-off checklist

Spec, built components (names and paths), test evidence (screenshots or records), switch-off steps, and the
migration package. Save it in the working folder and present it.
