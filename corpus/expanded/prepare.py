"""Pinned registry preparation for two functional build/library regressions."""
import base64, hashlib, io, json, pathlib, sys, tarfile, urllib.request

def download(pin):
    if not pin['tarball'].startswith('https://registry.npmjs.org/'):
        raise ValueError('Unexpected registry')
    with urllib.request.urlopen(pin['tarball'], timeout=30) as response:
        raw = response.read(10 * 1024 * 1024 + 1)
    if len(raw) > 10 * 1024 * 1024 or 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode() != pin['integrity']:
        raise ValueError('Archive integrity/size')
    return raw

def extract(raw, target):
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        members = archive.getmembers()
        if sum(m.size for m in members) > 32 * 1024 * 1024:
            raise ValueError('Expanded size')
        seen = set()
        for m in members:
            p = pathlib.PurePosixPath(m.name)
            if not p.parts or p.parts[0] != 'package' or '..' in p.parts or p.is_absolute() or '\\' in m.name:
                raise ValueError('Unsafe path')
            if m.isdir(): continue
            if not m.isfile() or len(p.parts) < 2 or p in seen: raise ValueError('Invalid entry')
            seen.add(p)
            dest = target.joinpath(*p.parts[1:]); dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.extractfile(m).read())

def prepare(root):
    root.mkdir(parents=True, exist_ok=False)
    for case in json.loads(pathlib.Path(__file__).with_name('cases.json').read_text()):
        support = {p['name']: download(p) for p in case['support']}
        for kind in ('buggy', 'fixed'):
            target = root / case['id'] / kind
            extract(download(case[kind]), target)
            pkg = json.loads((target/'package.json').read_text())
            if pkg['name'] != case[kind]['name'] or pkg['version'] != case[kind]['version']: raise ValueError('Identity mismatch')
            for key in ('scripts','devDependencies','dependencies'): pkg.pop(key, None)
            pkg['dependencies'] = {name: 'file:vendor/'+name+'.tgz' for name in support}
            (target/'vendor').mkdir()
            for name,raw in support.items(): (target/'vendor'/f'{name}.tgz').write_bytes(raw)
            (target/'package.json').write_text(json.dumps(pkg, indent=2)+'\n')
            for name,text in case['files'].items(): (target/name).write_text(text)
    print(root)

if __name__ == '__main__': prepare(pathlib.Path(sys.argv[1]).resolve())
