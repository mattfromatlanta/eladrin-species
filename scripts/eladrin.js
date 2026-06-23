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

async function updateEladrinItemName(actor, season) {
    const item = actor.items.find(i =>
        i.getFlag(MODULE_ID, "isEladrinSpeciesItem") === true
        || (i.type === "race" && i.name.startsWith("Eladrin"))
    );
    if (!item) return;
    const seasonLabel = SEASONS[season]?.label;
    const newName = seasonLabel ? `Eladrin (${seasonLabel})` : "Eladrin";
    if (item.name !== newName) await item.update({ name: newName });
}

// ── Utility: build weapon + tool option lists from CONFIG ─────────────────────
// In dnd5e v5, tools live in CONFIG.DND5E.tools and weapons in
// CONFIG.DND5E.weaponTypes (categories) + CONFIG.DND5E.weapons (individuals).
// We build a flat list of individual/specific entries the player can choose.

// In dnd5e v5, each weapon/tool entry is { ability, id } where `id` is a
// compendium UUID (e.g. "Compendium.dnd5e.equipment24.Item.phbtulAlchemists").
// The display name lives on the referenced Item document, not in CONFIG. We
// resolve it via fromUuidSync, which returns the pack's index entry — fast,
// no async — provided the pack index has been loaded (see the `ready` hook
// below, which preloads every pack referenced by these entries).

function resolveEntryLabel(key, data) {
    if (typeof data === "string") return data;
    if (data?.id) {
        const entry = fromUuidSync(data.id);
        if (entry?.name) return entry.name;
    }
    return data?.label ?? key;
}

function buildProficiencyOptions() {
    const weapons = [];
    const tools = [];

    for (const [key, data] of Object.entries(CONFIG.DND5E.weapons ?? {})) {
        weapons.push({ key: `weapon:${key}`, label: resolveEntryLabel(key, data) });
    }
    for (const [key, data] of Object.entries(CONFIG.DND5E.tools ?? {})) {
        tools.push({ key: `tool:${key}`, label: resolveEntryLabel(key, data) });
    }

    weapons.sort((a, b) => a.label.localeCompare(b.label));
    tools.sort((a, b) => a.label.localeCompare(b.label));

    return { weapons, tools };
}

// Preload every compendium pack referenced by weapon/tool entries so that
// fromUuidSync() can return index entries during the trance dialog. Without
// this, the first lookup of an unloaded pack returns null and labels fall
// back to the raw key.
async function preloadProficiencyPacks() {
    const packIds = new Set();
    const collect = entries => {
        for (const data of Object.values(entries ?? {})) {
            const uuid = data?.id;
            if (typeof uuid !== "string") continue;
            const m = uuid.match(/^Compendium\.([^.]+\.[^.]+)\./);
            if (m) packIds.add(m[1]);
        }
    };
    collect(CONFIG.DND5E.weapons);
    collect(CONFIG.DND5E.tools);

    await Promise.all([...packIds].map(id => game.packs.get(id)?.getIndex()));
}

Hooks.once("ready", preloadProficiencyPacks);

// DialogV2 force-adds the `dialog` class, which the dnd5e2 theme uses to
// trigger compact, title-hidden dialog styling. We want the full themed-app
// styling (visible title, gold legends, themed buttons) — so for any dialog
// we tag with dnd5e2, strip the `dialog` class after render.
Hooks.on("renderDialogV2", (app, element) => {
    if (!app.options.classes?.includes("dnd5e2")) return;
    element.classList.remove("dialog");
    const footer = element.querySelector("footer.form-footer");
    if (footer) footer.style.paddingTop = "0.75em";
});

function renderProficiencySelect(name, weapons, tools, selectedKey) {
    const opt = ({ key, label }) =>
        `<option value="${key}"${key === selectedKey ? " selected" : ""}>${label}</option>`;
    const wOpts = weapons.map(opt).join("");
    const tOpts = tools.map(opt).join("");
    return `
    <select name="${name}">
      <optgroup label="Weapons">${wOpts}</optgroup>
      <optgroup label="Tools">${tOpts}</optgroup>
    </select>
  `;
}

// ── Utility: apply trance proficiencies directly to actor traits ──────────────
// We store the chosen keys on the actor flag so we can remove them next rest.
// Direct actor.update() on the Sets is more reliable in v5 than Active Effects
// for temporary proficiencies we manage the lifecycle of ourselves.

// In dnd5e v5 (2024 rules) storage differs by type:
//   • Weapons → system.traits.weaponProf.value (Set of keys)
//   • Tools   → system.tools[key] = { value, ability, bonuses } (per-tool object)
// We persist the picks on a flag so the *next* trance can remove them before
// applying the new pair.

async function applyTranceProficiencies(actor, prof1Key, prof2Key) {
    await removeTranceProficiencies(actor);

    const picks = [prof1Key, prof2Key].filter(Boolean).map(k => {
        const [type, key] = k.split(":");
        return { type, key };
    });

    const newWeaponKeys = picks.filter(p => p.type === "weapon").map(p => p.key);
    const newToolKeys   = picks.filter(p => p.type === "tool").map(p => p.key);

    const updates = {};
    const applied = [];

    if (newWeaponKeys.length) {
        const current = new Set(actor.system.traits?.weaponProf?.value ?? []);
        for (const k of newWeaponKeys) {
            if (!current.has(k)) {
                current.add(k);
                applied.push({ type: "weapon", key: k });
            }
        }
        updates["system.traits.weaponProf.value"] = [...current];
    }

    for (const k of newToolKeys) {
        if (actor.system.tools?.[k]) continue; // already proficient
        const ability = CONFIG.DND5E.tools?.[k]?.ability ?? "int";
        updates[`system.tools.${k}`] = {
            value: 1,
            ability,
            bonuses: { check: "" }
        };
        applied.push({ type: "tool", key: k });
    }

    if (Object.keys(updates).length) {
        await actor.update(updates);
    }

    await actor.setFlag(MODULE_ID, "tranceProfs", applied);
}

async function removeTranceProficiencies(actor) {
    const prev = actor.getFlag(MODULE_ID, "tranceProfs") ?? [];
    if (!prev.length) return;

    const updates = {};

    const weaponKeys = prev.filter(p => p.type === "weapon").map(p => p.key);
    if (weaponKeys.length) {
        const current = new Set(actor.system.traits?.weaponProf?.value ?? []);
        for (const k of weaponKeys) current.delete(k);
        updates["system.traits.weaponProf.value"] = [...current];
    }

    // Foundry deletion syntax: `-=key` removes that subkey from the parent object.
    for (const { key } of prev.filter(p => p.type === "tool")) {
        updates[`system.tools.-=${key}`] = null;
    }

    if (Object.keys(updates).length) {
        await actor.update(updates);
    }

    await actor.unsetFlag(MODULE_ID, "tranceProfs");
}

// ── Shared: season radio HTML ─────────────────────────────────────────────────

function renderSeasonRadios(currentSeason) {
    return Object.entries(SEASONS).map(([key, s]) => `
    <label class="checkbox" style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <input type="radio" name="season" value="${key}"
        ${key === currentSeason ? "checked" : ""}>
      <p style="margin:0;line-height:1.4;font-size:1.25em;">
        <span style="font-weight:bold;color:${s.color};white-space:nowrap;">${s.icon} ${s.label}: </span>
        <span>${s.desc} — ${s.effectDesc}</span>
      </p>
    </label>
  `).join("");
}

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
    <section class="flexcol" style="gap:10px;">
      <div class="note info">
        ${actor.name} steps from the Feywild, shaped by its boundless magic.
        Choose their starting season and the ability score their Fey Step
        effects will key off when they reach 3rd level.
      </div>
      <fieldset>
        <legend>Starting Season</legend>
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${renderSeasonRadios("spring")}
        </div>
      </fieldset>
      <fieldset>
        <legend>Fey Step Save DC Ability</legend>
        <p class="hint" style="margin:0 0 6px;">
          Used by Autumn (Charm) and Winter (Frighten) effects at level 3+.
          DC = 8 + proficiency bonus + chosen modifier.
        </p>
        <select name="dcAbility" style="width:100%;">
          <option value="int">Intelligence</option>
          <option value="wis">Wisdom</option>
          <option value="cha" selected>Charisma</option>
        </select>
      </fieldset>
    </section>
  `;

    const result = await foundry.applications.api.DialogV2.wait({
        window: { title: `Eladrin — ${actor.name}` },
        classes: ["dnd5e2"],
        position: { width: 480 },
        content,
        buttons: [
            {
                action: "confirm",
                icon: "fas fa-leaf",
                label: "Enter the Feywild",
                default: true,
                callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
            },
            { action: "later", label: "Set Up Later" }
        ],
        rejectClose: false
    });

    if (!result || result === "later") {
        ui.notifications.warn(
            `Eladrin setup skipped for ${actor.name}. Re-add the species item to configure.`
        );
        return;
    }

    const season = result.season ?? "spring";
    const dcAbility = result.dcAbility ?? "cha";
    const s = SEASONS[season];

    await actor.setFlag(MODULE_ID, "isEladrin", true);
    await actor.setFlag(MODULE_ID, "season", season);
    await actor.setFlag(MODULE_ID, "saveDCAbility", dcAbility);
    await updateEladrinItemName(actor, season);

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
});

// ── Hook 2: Long rest → Trance dialog ────────────────────────────────────────
// Prompts the player to pick a new season and two temporary proficiencies.

Hooks.on("dnd5e.restCompleted", async (actor, data) => {
    if (!data.longRest) return;
    if (!isEladrin(actor)) return;
    if (!actor.isOwner) return;

    const currentSeason = actor.getFlag(MODULE_ID, "season") ?? "spring";
    const { weapons, tools } = buildProficiencyOptions();

    const prevPicks = actor.getFlag(MODULE_ID, "tranceProfs") ?? [];
    const prevKey = i => prevPicks[i] ? `${prevPicks[i].type}:${prevPicks[i].key}` : undefined;

    const content = `
    <section class="flexcol" style="gap:10px;">
      <div class="note info">
        ${actor.name} finishes 4 hours of trancelike meditation, drawing on
        the shared memory of elvenkind and the shifting magic of the Feywild.
      </div>
      <fieldset>
        <legend>Choose Your Season</legend>
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${renderSeasonRadios(currentSeason)}
        </div>
      </fieldset>
      <fieldset>
        <legend>Trance Proficiencies</legend>
        <p class="hint" style="margin:0 0 6px;">
          Choose 2 weapons or tools. These proficiencies last until your
          next long rest, drawn from shared elven memory.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          ${renderProficiencySelect("prof1", weapons, tools, prevKey(0))}
          ${renderProficiencySelect("prof2", weapons, tools, prevKey(1))}
        </div>
      </fieldset>
    </section>
  `;

    const result = await foundry.applications.api.DialogV2.wait({
        window: { title: `Eladrin Trance — ${actor.name}` },
        classes: ["dnd5e2"],
        position: { width: 480 },
        content,
        buttons: [
            {
                action: "confirm",
                icon: "fas fa-moon",
                label: "Complete the Trance",
                default: true,
                callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
            },
            { action: "skip", label: "Skip" }
        ],
        rejectClose: false
    });

    if (!result || result === "skip") return;

    const newSeason = result.season ?? currentSeason;
    const prof1 = result.prof1;
    const prof2 = result.prof2;
    const s = SEASONS[newSeason];

    await actor.setFlag(MODULE_ID, "season", newSeason);
    await updateEladrinItemName(actor, newSeason);
    await applyTranceProficiencies(actor, prof1, prof2);

    const { weapons: wList, tools: tList } = buildProficiencyOptions();
    const allProfs = [...wList, ...tList];
    const labelOf = key => allProfs.find(p => p.key === key)?.label ?? key?.split(":")[1] ?? "";

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

    // dnd5e 5.x: Actor5e#rollAbilitySave was removed in favor of #rollSavingThrow,
    // which takes a config object ({ ability, target }) and resolves to a D20Roll[]
    // (the DC goes in `target`, surfacing roll.isSuccess / roll.isFailure).
    async function rollSave(target) {
        const rolls = await target.actor.rollSavingThrow({
            ability: "wis",
            target: saveDC
        });
        return rolls?.[0] ?? null;
    }

    switch (season) {

        case "autumn": {
            if (!targets.length)
                return ui.notifications.warn("Autumn Fey Step: target up to 2 creatures first.");
            const victims = targets.slice(0, 2);
            for (const t of victims) {
                const roll = await rollSave(t);
                if (roll?.isFailure)
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
            if (roll?.isFailure)
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