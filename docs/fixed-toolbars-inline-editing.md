# Fixed toolbars and inline appearance editing

The common browser, toolbar and appearance modules apply to all households/events and administrator pages. The compact browsing layout remains limited to Family Workspace and Contacts. Household/event content, artwork, invitations, registries and RSVP layout remain in the existing renderer.

## Navigation and management

Home selects the signed-in landing page directly; it never uses browser history or a list/folder root as a substitute. Back remains local navigation. Every page has a fixed top toolbar with Gather at the left. Fixed bottom navigation uses borderless icons above labels; both heights are measured so wrapping, phone safe areas and the three editor levels cannot cover content.

Host bottom navigation is Home, Family, Contacts, Edit House/Edit Event, Share, Settings. Only the edit action differs on an event. Print and Edit event details are top-toolbar actions; Household details is in the home options menu. Content fields/logo/timezone and event deletion remain available in those content editors. Share keeps the household guest-facing URL and native/copy behavior. Settings contains existing preferences, password changes, permitted family management and Sign Out. Family/member/child permissions remain enforced by the server. Guests receive Home, applicable Print and Settings; no host editing or contact management controls.

Administrator navigation uses Home, Approvals, Hosts, Defaults, Templates and Settings. Top menus provide relevant creation/preview actions. Approvals, registered hosts, recovery, templates, preview selection and default editing are dedicated/inline management views; account-deletion confirmation remains a dialog. There is one Templates destination. Approval still sends no emails; previews are read-only. Settings includes an administrator current-password-verified password change, which revokes existing sessions, and Sign Out.

Contacts keeps the existing guest/address database. A name/pencil opens its editor beneath that row. Add Guest creates a browser-only blank row; Save commits only validated information, and Cancel removes it. Polling pauses while the inline editor exists; ordinary rerenders retain its actual form/draft. Address selection/edit/create, identity review, children, private notes, consent and code display retain existing validation and atomic versioned writes. Groups use address IDs, never displayed-title matching; alphabetical sorting orders groups by title with an ID tie-break, keeping each guest in their address group. Unassigned people appear under No shared address. Manual guest ordering does not change address membership.

## One five-category editor

`public/appearance-editor.js` owns the same draft/preview/Save/Cancel/copy/reset implementation for household, event and global scopes. Edit House/Event enter the toolbar directly. Edit Global Defaults opens the real synthetic page renderer with the same toolbar editor. Shared wording and structured layout controls remain a separate administrator-only visual inspector; individual household editing is still denied to administrators.

| Category    | Formatting scope                                                                        | Actions                                                    |
| ----------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Background  | Page color/image                                                                        | Color, Image, Save, Cancel                                 |
| Titles      | All headings                                                                            | Font, Color, Style, Size, Save, Cancel                     |
| Description | Descriptions and When/Where/RSVP By labels/values                                       | Font, Color, Style, Size, Save, Cancel                     |
| Text        | All other text/icons: eyebrows, notes, controls, toolbar labels, helpers, counts/status | Font, Color, Style, Size, Save, Cancel                     |
| Containers  | Panels/cards, menus, grouped rows, controls/buttons and toolbar surfaces/borders        | Background/opacity, Border color/width/style, Save, Cancel |

The selected action's actual controls occupy the third toolbar. Every level wraps within the viewport. Font style supports normal, bold, italic and bold italic. Copy Formatting and confirmed Reset to Defaults are in Formatting options, with no sixth category. Switching categories keeps the same unsaved draft. Cancel restores saved values; navigation prompts before discarding. Save waits for a pending image read, validates on the server and retains drafts after failure/conflict. Content editors contain no independent appearance controls. Card/template document-element formatting remains its separate existing card design, not another page appearance category.

## Deterministic legacy migration and inheritance

`categoryDesign` in `public/ui-system.js` performs a compatibility migration on each appearance layer before inheritance. It retains existing storage until a normal versioned save writes the normalized values; it does not rewrite unrelated content or guest responses. Explicit category keys win. If absent, the first saved field below supplies that category:

- Text color: toolbarColor, inputColor, notesColor, buttonText, statusColor, eyebrowColor, linkColor, accentColor, dangerColor.
- Text font: toolbarFont, notesFont, buttonFont, statusFont, eyebrowFont.
- Text size: toolbarSize, notesSize, buttonSize, statusSize, eyebrowSize.
- Containers background: toolbarBackground, inputBackground, notesBackground, statusBackground, dangerBackground, buttonColor.

Those legacy aliases then mirror their category. Title/description and page-background keys retain their existing category meanings. New style/border width/style settings use validated defaults. Text and surfaces are mapped independently. Relative heading/compact navigation sizes preserve responsive design while following the category size.

Resolve platform → household → event after normalizing each layer, so legacy event overrides retain precedence. Household saves transactionally preserve existing event appearance; global appearance saves preserve each existing household's resolved appearance. Wording/layout defaults continue to apply globally. Host saves omit resolved administrator-only UI configuration and cannot alter shared wording/layout. No new namespace, database, routing, messaging provider or background cron is introduced.

## Verification and release

Use Node.js 24, `npm ci`, `npm test`, all six `npm run test:mobile` suites, `npm run test:cloudflare`, formatting/whitespace and Worker dry-run checks. Tests use synthetic loopback databases and mock only native print/share boundaries. Cover every navigation/permission scope, inline guest drafts, address grouping, all five categories, live preview, image handling, Save/Cancel/refresh and independently scoped defaults/events. Inspect phone/desktop screenshots and measured toolbar clearance.

Release only the reviewed application merge through the existing events-only procedure. The successful release of preceding PR #15 was run 41397498202, Worker version `8d49ef2a-334c-417b-84ac-97981a230a0e`; repeat run 41402613254 stopped at its previous-version guard because that release was already deployed. Never weaken the guard or redeploy the previous release to address that expected stop. A new release needs a fresh version/settings/setup/recovery checkpoint and the new reviewed commit pinned on main. Keep SMS, automatic builds and previews disabled. Preserve bindings, secrets, variables, routes, cron and data; never deploy the gateway. Local validation is not live production acceptance.

## Validation evidence

Node.js 24 validation passed: 85 application/API tests, all six synthetic browser suites, the actual local Worker/SQLite suite, formatting/whitespace, both Worker dry-run bundles and a zero-finding production dependency audit. Targeted editor and toolbar reruns also passed after the final administrator/template/example changes. Screenshots include phone/desktop event pages, administrator Settings and the active three-level global editor. No production fixtures, guest-response edits, messages, account deletions or gateway deployment were used. GitHub validation remains the merge gate; production acceptance still requires existing authorized sessions after deployment.
