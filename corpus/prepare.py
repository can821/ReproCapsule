"""Fetch pinned npm source distributions; never install or run upstream scripts."""
import base64, hashlib, io, json, pathlib, sys, tarfile, urllib.request
catalog = json.loads(pathlib.Path(__file__).with_name('cases.json').read_text())
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=False)
for case in catalog:
    target = root / case['name']
    target.mkdir()
    with urllib.request.urlopen(case['tarball'], timeout=30) as response:
        raw = response.read(5 * 1024 * 1024 + 1)
    if len(raw) > 5 * 1024 * 1024 or 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode() != case['integrity']:
        raise ValueError('Download size/integrity mismatch')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        members = archive.getmembers()
        if sum(m.size for m in members) > 20 * 1024 * 1024:
            raise ValueError('Expanded archive too large')
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            if not name.parts or name.parts[0] != 'package' or '..' in name.parts or name.is_absolute() or '\\' in member.name:
                raise ValueError('Unsafe archive path')
            if member.isdir(): continue
            if not member.isfile(): raise ValueError('Links/special files not allowed')
            dest = target.joinpath(*name.parts[1:])
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.extractfile(member).read())
    pkg = json.loads((target / 'package.json').read_text())
    if pkg.get('name') != case['name'] or pkg.get('version') != case['version'] or pkg.get('dependencies'):
        raise ValueError('Unexpected package identity/production dependencies')
    # Explicit corpus adaptation: run the published production code with a tiny
    # negative-input harness, not upstream's development test/build environment.
    pkg.pop('devDependencies', None)
    pkg.pop('scripts', None)
    (target / 'package.json').write_text(json.dumps(pkg, indent=2)+'\n')
    (target / 'probe.cjs').write_text(case['probe']+'\n')
    lock = {'name':pkg['name'], 'version':pkg['version'], 'lockfileVersion':3, 'requires':True,
            'packages':{'':{'name':pkg['name'], 'version':pkg['version']}}}
    (target / 'package-lock.json').write_text(json.dumps(lock, indent=2)+'\n')
print(str(root))
