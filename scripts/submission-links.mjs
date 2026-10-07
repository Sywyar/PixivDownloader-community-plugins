export async function marketLinks(sdk, ui, locale, previous, repository = '') {
    const maximum = sdk.invoke({ command: 'content-limits' }).links;
    const presets = ['repository', 'documentation', 'issues'];
    const old = previous?.links ?? (previous?.homepageUrl ? [{ kind: 'repository', url: previous.homepageUrl }] : []);
    const selected = await ui.multiselect('linkPresets', presets, previous?.links === undefined
        ? presets : presets.filter(kind => old.some(link => link.kind === kind)));
    const links = old.filter(link => link.kind === 'custom').map(link => structuredClone(link));
    const check = value => sdk.invoke({ command: 'links', value });
    const title = link => link.kind === 'custom' ? link.label[locale] ?? Object.values(link.label)[0] : ui.text(link.kind);
    for (const kind of selected) {
        const url = await ui.ask('linkUrl', old.find(link => link.kind === kind)?.url ?? (kind === 'repository' ? repository : ''),
            url => { if (url) check([...links, { kind, url }]); }, { identity: ['preset', kind], remember: false });
        if (url) links.push({ kind, url });
    }
    for (;;) {
        ui.say('links', links);
        const action = await ui.select('linkAction', ['linksDone', ...(links.length < maximum ? ['linkAdd'] : []),
            ...(links.length ? ['linkEdit', 'linkDelete'] : [])], key => ui.text(key));
        if (action === 'linksDone') { check(links); return links; }
        if (action === 'linkAdd') {
            const label = await ui.ask('linkLabel', '', label => check([{ kind: 'custom', url: 'https://example.invalid', label: { [locale]: label } }]),
                { identity: ['new', links], remember: false });
            const url = await ui.ask('linkUrl', '', url => { if (url) check([...links, { kind: 'custom', url, label: { [locale]: label } }]); },
                { identity: ['new', label, links], remember: false });
            if (url) links.push({ kind: 'custom', url, label: { [locale]: label } });
        } else {
            const original = await ui.select('linkChoose', links, link => `${title(link)} — ${link.url}`);
            const index = links.indexOf(original);
            if (action === 'linkDelete') { links.splice(index, 1); continue; }
            const replacement = structuredClone(original);
            if (replacement.kind === 'custom') replacement.label[locale] = await ui.ask('linkLabel', title(original),
                label => check([{ ...replacement, label: { ...replacement.label, [locale]: label } }]),
                { identity: original, remember: false });
            replacement.url = await ui.ask('linkUrl', original.url, url => {
                if (url) check(links.map((link, i) => i === index ? { ...replacement, url } : link));
            }, { identity: original, remember: false });
            if (replacement.url) links[index] = replacement; else links.splice(index, 1);
        }
    }
}
