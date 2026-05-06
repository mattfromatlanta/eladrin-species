/**
 * eladrin.js — Eladrin Species Automation
 * For: Foundry VTT V12–V14, dnd5e system v5.x, 2024 rules
 *
 * Handles:
 *  1. Season + DC ability setup dialog, triggered automatically when the
 *     Eladrin species item is assigned via the advancement manager.
 *  2. Long rest Trance dialog: season change + temporary weapon/tool profs.
 *  3. Fey Step seasonal effect, triggered via dnd5e.postUseActivity hook.
 */

const MODULE_ID = "eladrin-species";

// ── Season definitions ────────────────────────────────────────────────────────

const SEASONS = {
    autumn: {
        label: "Autumn",
        icon: "🍂",
        color: "#b85c1a",
        desc: "Peace & goodwill",
        effectDesc: "Charm up to 2 creatures within 10ft after teleporting (Wis save)"
    },
    winter: {
        label: "Winter",
        icon: "❄️",
        color: "#5b9ebd",
        desc: "Contemplation & dolor",
        effectDesc: "Frighten 1 creature within 5ft before teleporting (Wis save)"
    },
    spring: {
        label: "Spring",
        icon: "🌸",
        color: "#c45c7a",
        desc: "Cheerfulness & celebration",
        effectDesc: "A willing ally within 5ft teleports instead of you"
    },
    summer: {
        label: "Summer",
        icon: "☀️",
        color: "#c49a1a",
        desc: "Boldness & aggression",
        effectDesc: "Chosen creatures within 5ft take fire damage equal to your proficiency bonus"
    }
};

// ── Utility: is this actor a configured Eladrin? ─────────────────────────────

function isEladrin(actor) {
    return actor?.getFlag(MODULE_ID, "isEladrin") === true;
}

// ── Utility: build weapon + tool option lists from CONFIG ─────────────────────
// In dnd5e v5, tools live in CONFIG.DND5E.tools and weapons in
// CONFIG.DND5E.weaponTypes (categories) + CONFIG.DND5E.weapons (individuals).
// We build a flat list of individual/specific entries the player can choose.

function buildProficiencyOptions() {
    const weapons = [];
    const tools = [];

    // Weapon entries — individual weapons (not category keys like "sim"/"mar")
    const weaponEntries = CONFIG.DND5E.weapons ?? {};
    for (const [key, data] of Object.entries(weaponEntries)) {
        const label = typeof data === "string" ? data : (data.label ?? key);
        weapons.push({ key: `weapon:${key}`, label });
    }

    // Tool entries
    const toolEntries = CONFIG.DND5E.tools ?? {};
    for (const [key, data] of Object.entries(toolEntries)) {
        const label = typeof data === "string" ? data : (data.label ?? key);
        tools.push({ key: `tool:${key}`, label });
    }

    weapons.sort((a, b) => a.label.localeCompare(b.label));
    tools.sort((a, b) => a.label.localeCompare(b.label));

    return { weapons, tools };
}

function renderProficiencySelect(id, weapons, tools) {
    const wOpts = weapons.map(w =>
        `<option value="${w.key}">${w.label}</option>`).join("");
    const tOpts = tools.map(t =>
        `<option value="${t.key}">${t.label}</option>`).join("");
    return `
    <select id="${id}">
      <optgroup label="Weapons">${wOpts}</optgroup>
      <optgroup label="Tools">${tOpts}</optgroup>
    </select>
  `;
}

// ── Utility: apply trance proficiencies directly to actor traits ──────────────
// We store the chosen keys on the actor flag so we can remove them next rest.
// Direct actor.update() on the Sets is more reliable in v5 than Active Effects
// for temporary proficiencies we manage the lifecycle of ourselves.

async function applyTranceProficiencies(actor, prof1Key, prof2Key) {
    // Remove previous trance profs first
    await removeTranceProficiencies(actor);

    const updates = {};
    const toApply = [prof1Key, prof2Key];
    const applied = [];

    for (const profKey of toApply) {
        const [type, key] = profKey.split(":");
        if (type === "weapon") {
            const current = new Set(actor.system.traits?.weaponProf?.value ?? []);
            if (!current.has(key)) {
                current.add(key);
                updates["system.traits.weaponProf.value"] = [...current];
                applied.push({ type, key });
            }
        } else if (type === "tool") {
            const current = new Set(actor.system.traits?.toolProf?.value ?? []);
            if (!current.has(key)) {
                current.add(key);
                updates["system.traits.toolProf.value"] = [...current];
                applied.push({ type, key });
            }
        }
    }

    if (Object.keys(updates).length) {
        await actor.update(updates);
    }

    // Store what we applied so we can clean up next long rest
    await actor.setFlag(MODULE_ID, "tranceProfs", applied);
}

async function removeTranceProficiencies(actor) {
    const prev = actor.getFlag(MODULE_ID, "tranceProfs") ?? [];
    if (!prev.length) return;

    const updates = {};

    // Group by type to do one update per type
    const weaponKeys = prev.filter(p => p.type === "weapon").map(p => p.key);
    const toolKeys = prev.filter(p => p.type === "tool").map(p => p.key);

    if (weaponKeys.length) {
        const current = new Set(actor.system.traits?.weaponProf?.value ?? []);
        for (const k of weaponKeys) current.delete(k);
        updates["system.traits.weaponProf.value"] = [...current];
    }
    if (toolKeys.length) {
        const current = new Set(actor.system.traits?.toolProf?.value ?? []);
        for (const k of toolKeys) current.delete(k);
        updates["system.traits.toolProf.value"] = [...current];
    }

    if (Object.keys(updates).length) {
        await actor.update(updates);
    }

    await actor.unsetFlag(MODULE_ID, "tranceProfs");
}

// ── Shared: season radio HTML ─────────────────────────────────────────────────

function renderSeasonRadios(currentSeason) {
    return Object.entries(SEASONS).map(([key, s]) => `
    <label class="es-season-option" style="border-left:4px solid ${s.color};">
      <input type="radio" name="season" value="${key}"
        ${key === currentSeason ? "checked" : ""}>
      <span class="es-season-label">${s.icon} ${s.label}</span>
      <span class="es-season-subdesc">${s.desc}</span>
      <span class="es-season-effect">${s.effectDesc}</span>
    </label>
  `).join("");
}

const SHARED_STYLES = `
  <style>
    .es-dialog p.flavour { font-style:italic; color:#666; margin-bottom:12px; font-size:.9em; }
    .es-season-option {
      display:grid;
      grid-template-columns:auto 1fr;
      grid-template-rows:auto auto auto;
      gap:0 8px;
      align-items:center;
      padding:6px 10px;
      margin:4px 0;
      border-radius:4px;
      border:1px solid #ccc;
      background:#fafafa;
      cursor:pointer;
    }
    .es-season-option input { grid-row:span 3; }
    .es-season-label { font-weight:bold; }
    .es-season-subdesc { font-size:.82em; color:#555; }
    .es-season-effect { font-size:.78em; color:#777; font-style:italic; }
    .es-section-head { margin:12px 0 4px; font-weight:bold; }
    .es-prof-row { display:flex; gap:8px; margin-top:6px; }
    .es-prof-row select { flex:1; min-width:0; }
    .es-hint { font-size:.82em; color:#666; margin:2px 0 8px; }
  </style>
`;

// ── Hook 1: Species assignment → setup dialog ─────────────────────────────────
// Fires when any item is added via the advancement manager.
// We detect the Eladrin species item by flag (most robust) or by name fallback.

Hooks.on("createItem", async (item, options, userId) => {
    if (!options.isAdvancement) return;
    if (userId !== game.user.id) return;

    const actor = item.parent;
    if (!actor || actor.type !== "character") return;

    // Match by embedded module flag (preferred) or by item type + name
    const isEladrinSpeciesItem =
        item.getFlag(MODULE_ID, "isEladrinSpeciesItem") === true ||
        (item.type === "race" && item.name === "Eladrin");

    if (!isEladrinSpeciesItem) return;

    // Don't re-run if already configured
    if (actor.getFlag(MODULE_ID, "isEladrin")) return;

    // Let the advancement manager UI fully close before rendering our dialog
    await new Promise(r => setTimeout(r, 300));

    const content = `
    ${SHARED_STYLES}
    <div class="es-dialog">
      <p class="flavour">
        ${actor.name} steps from the Feywild, shaped by its boundless magic.
        Choose their starting season and the ability score their Fey Step
        effects will key off when they reach 3rd level.
      </p>
      <p class="es-section-head">Starting Season</p>
      ${renderSeasonRadios("spring")}
      <p class="es-section-head">Fey Step Save DC Ability</p>
      <p class="es-hint">
        Used by Autumn (Charm) and Winter (Frighten) effects at level 3+.
        DC = 8 + proficiency bonus + chosen modifier.
      </p>
      <select id="es-dc" style="width:100%;">
        <option value="int">Intelligence</option>
        <option value="wis">Wisdom</option>
        <option value="cha" selected>Charisma</option>
      </select>
    </div>
  `;

    new Dialog({
        title: `Eladrin — ${actor.name}`,
        content,
        buttons: {
            confirm: {
                icon: `<i class="fas fa-leaf"></i>`,
                label: "Enter the Feywild",
                callback: async (html) => {
                    const season = html.find("input[name='season']:checked").val() ?? "spring";
                    const dcAbility = html.find("#es-dc").val() ?? "cha";
                    const s = SEASONS[season];

                    await actor.setFlag(MODULE_ID, "isEladrin", true);
                    await actor.setFlag(MODULE_ID, "season", season);
                    await actor.setFlag(MODULE_ID, "saveDCAbility", dcAbility);

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        content: `
              <div style="border:2px solid ${s.color};border-radius:6px;padding:10px;background:#fafafa;">
                <strong>🧝 ${actor.name} — Eladrin of ${s.icon} ${s.label}</strong><br>
                <em style="color:#666;font-size:.9em;">${s.desc} — ${s.effectDesc}</em><br>
                <small>Their season shifts with each long rest.</small>
              </div>
            `
                    });
                }
            },
            later: {
                label: "Set Up Later",
                callback: () => ui.notifications.warn(
                    `Eladrin setup skipped for ${actor.name}. Re-add the species item to configure.`
                )
            }
        },
        default: "confirm"
    }).render(true);
});

// ── Hook 2: Long rest → Trance dialog ────────────────────────────────────────
// Prompts the player to pick a new season and two temporary proficiencies.

Hooks.on("dnd5e.restCompleted", async (actor, data) => {
    if (!data.longRest) return;
    if (!isEladrin(actor)) return;
    if (!actor.isOwner) return;

    const currentSeason = actor.getFlag(MODULE_ID, "season") ?? "spring";
    const { weapons, tools } = buildProficiencyOptions();

    const content = `
    ${SHARED_STYLES}
    <div class="es-dialog">
      <p class="flavour">
        ${actor.name} finishes 4 hours of trancelike meditation, drawing on
        the shared memory of elvenkind and the shifting magic of the Feywild.
      </p>
      <p class="es-section-head">Choose Your Season</p>
      ${renderSeasonRadios(currentSeason)}
      <p class="es-section-head" style="margin-top:14px;">
        Trance Proficiencies
      </p>
      <p class="es-hint">
        Choose 2 weapons or tools. These proficiencies last until your
        next long rest, drawn from shared elven memory.
      </p>
      <div class="es-prof-row">
        ${renderProficiencySelect("es-prof1", weapons, tools)}
        ${renderProficiencySelect("es-prof2", weapons, tools)}
      </div>
    </div>
  `;

    return new Promise(resolve => {
        new Dialog({
            title: `Eladrin Trance — ${actor.name}`,
            content,
            buttons: {
                confirm: {
                    icon: `<i class="fas fa-moon"></i>`,
                    label: "Complete the Trance",
                    callback: async (html) => {
                        const newSeason = html.find("input[name='season']:checked").val() ?? currentSeason;
                        const prof1 = html.find("#es-prof1").val();
                        const prof2 = html.find("#es-prof2").val();
                        const s = SEASONS[newSeason];

                        await actor.setFlag(MODULE_ID, "season", newSeason);
                        await applyTranceProficiencies(actor, prof1, prof2);

                        // Resolve labels for chat
                        const { weapons: wList, tools: tList } = buildProficiencyOptions();
                        const allProfs = [...wList, ...tList];
                        const labelOf = key => allProfs.find(p => p.key === key)?.label ?? key.split(":")[1];

                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor }),
                            content: `
                <div style="border:2px solid ${s.color};border-radius:6px;padding:10px;background:#fafafa;">
                  <strong>🧝 ${actor.name} — Eladrin Trance</strong><br>
                  Season: <strong style="color:${s.color};">${s.icon} ${s.label}</strong>
                  <em style="color:#666;font-size:.9em;"> — ${s.effectDesc}</em><br>
                  <small>
                    Draws <strong>${labelOf(prof1)}</strong> and
                    <strong>${labelOf(prof2)}</strong>
                    from elven memory until next long rest.
                  </small>
                </div>
              `
                        });

                        resolve();
                    }
                },
                skip: {
                    label: "Skip",
                    callback: resolve
                }
            },
            default: "confirm",
            close: resolve
        }).render(true);
    });
});

// ── Hook 3: Fey Step activity use → seasonal effect ───────────────────────────
// Fires after ANY activity is used; we filter to Fey Step on Eladrin actors.

Hooks.on("dnd5e.postUseActivity", async (activity, usageConfig, results) => {
    const actor = activity.actor;
    if (!actor || !isEladrin(actor)) return;

    if (activity.item?.name !== "Fey Step") return;

    const level = actor.system.details?.level ?? 0;
    if (level < 3) return;

    const season = actor.getFlag(MODULE_ID, "season") ?? "summer";
    const dcAbility = actor.getFlag(MODULE_ID, "saveDCAbility") ?? "cha";
    const abilityMod = actor.system.abilities?.[dcAbility]?.mod ?? 0;
    const prof = actor.system.attributes?.prof ?? 2;
    const saveDC = 8 + prof + abilityMod;
    const targets = [...game.user.targets];
    const s = SEASONS[season];

    async function rollSave(target) {
        return target.actor.rollAbilitySave("wis", {
            targetValue: saveDC,
            chatMessage: true
        });
    }

    switch (season) {

        case "autumn": {
            if (!targets.length)
                return ui.notifications.warn("Autumn Fey Step: target up to 2 creatures first.");
            const victims = targets.slice(0, 2);
            for (const t of victims) {
                const roll = await rollSave(t);
                if (roll?.total < saveDC)
                    await t.actor.toggleStatusEffect("charmed", { active: true });
            }
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<div style="border:2px solid ${s.color};border-radius:6px;padding:8px;background:#fafafa;">
          <strong>🍂 Autumn Fey Step</strong><br>
          <em>${victims.map(t => t.name).join(", ")} make a DC ${saveDC} Wisdom save
          or are <strong>Charmed</strong> for 1 minute (breaks on damage).</em></div>`
            });
            break;
        }

        case "winter": {
            if (!targets.length)
                return ui.notifications.warn("Winter Fey Step: target 1 creature first.");
            const t = targets[0];
            const roll = await rollSave(t);
            if (roll?.total < saveDC)
                await t.actor.toggleStatusEffect("frightened", { active: true });
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<div style="border:2px solid ${s.color};border-radius:6px;padding:8px;background:#fafafa;">
          <strong>❄️ Winter Fey Step</strong><br>
          <em>${t.name} makes a DC ${saveDC} Wisdom save
          or is <strong>Frightened</strong> until end of your next turn.</em></div>`
            });
            break;
        }

        case "spring": {
            if (!targets.length)
                return ui.notifications.warn("Spring Fey Step: target the willing ally first.");
            const t = targets[0];
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<div style="border:2px solid ${s.color};border-radius:6px;padding:8px;background:#fafafa;">
          <strong>🌸 Spring Fey Step</strong><br>
          <em>${t.name} teleports up to 30ft to an unoccupied space
          ${actor.name} chooses. (Resolve token placement manually.)</em></div>`
            });
            break;
        }

        case "summer": {
            if (!targets.length)
                return ui.notifications.warn("Summer Fey Step: target creatures within 5ft first.");
            const damage = prof;
            for (const t of targets)
                await t.actor.applyDamage([{ value: damage, type: "fire" }]);
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<div style="border:2px solid ${s.color};border-radius:6px;padding:8px;background:#fafafa;">
          <strong>☀️ Summer Fey Step</strong><br>
          <em>${targets.map(t => t.name).join(", ")} take
          <strong>${damage} fire damage</strong>.</em></div>`
            });
            break;
        }
    }
});