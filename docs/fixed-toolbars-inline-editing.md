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

## Event chooser and summary row follow-up

Host event cards place event details and View Event on the left, with RSVPs, Reminders, Cards and Invitation stacked on the right. Each action keeps that event's ID; shared card/template and reminder behavior is unchanged. The top event summary shares the primary toolbar row with Gather, options and Print. Its middle region can scroll horizontally on phones, keeping the edge actions available without page overflow. Guest summaries still contain only permitted potluck information. The normal sync timestamp and host-home introductory tagline are removed; background refresh and connection-failure status remain intact. No saved content, responses, formatting, reminder delivery settings or runtime resources are changed by this presentation update.

## Contact invitation selection

Invite Guests and Uninvited Guests stay sticky at the top of the Contacts container below the global header. Uninvited Guests means contacts not invited to any saved event. Either action enters multi-selection; the primary action becomes a green Select Event button, disabled until a contact is selected. Selecting a child visibly selects their designated adult. Search/filter changes retain explicit selection; the selected count remains visible. Cancel clears only this browser draft. Background refresh pauses while selection is active, and the event picker refreshes authorized data before showing owned events.

Choosing an event adds the selected IDs through the shared host-only, version-required `POST /api/host/events/:id/invite-guests` endpoint. It validates the complete invitation union with the same validator used by event editing and commits atomically. It cannot remove existing invitations or change event content, private notes, formatting, guest credentials or RSVP records. A stale version leaves the selection visible, refreshes the event list and requires another explicit click. Mixed-tenant IDs and child-only invitations fail without partial writes. No email or SMS is sent by this operation. Existing consent/provider controls remain unchanged.
