"""Prepare integrity-pinned ordinary functional regressions without install scripts."""
import base64, hashlib, io, json, pathlib, shutil, sys, tarfile, urllib.request


def prepare(root):
    cases = json.loads(pathlib.Path(__file__).with_name('cases.json').read_text())
    root.mkdir(parents=True, exist_ok=False)
    for case in cases:
        for kind in ('buggy', 'fixed'):
            pin = case[kind]
            if not pin['tarball'].startswith('https://registry.npmjs.org/'):
                raise ValueError('Unexpected registry')
            with urllib.request.urlopen(pin['tarball'], timeout=30) as response:
                raw = response.read(5 * 1024 * 1024 + 1)
            digest = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()
            if len(raw) > 5 * 1024 * 1024 or digest != pin['integrity']:
                raise ValueError('Archive size/integrity mismatch')
            target = root / case['id'] / kind
            target.mkdir(parents=True)
            with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
                members = archive.getmembers()
                if sum(m.size for m in members) > 20 * 1024 * 1024:
                    raise ValueError('Expanded archive too large')
                seen = set()
                for member in members:
                    name = pathlib.PurePosixPath(member.name)
                    if not name.parts or name.parts[0] != 'package' or '..' in name.parts or name.is_absolute() or '\\' in member.name:
                        raise ValueError('Invalid archive path')
                    if member.isdir():
                        continue
                    if not member.isfile() or len(name.parts) < 2 or name in seen:
                        raise ValueError('Invalid archive entry')
                    seen.add(name)
                    dest = target.joinpath(*name.parts[1:])
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(archive.extractfile(member).read())
            pkg = json.loads((target / 'package.json').read_text())
            if pkg['name'] != case['package'] or pkg['version'] != pin['version'] or pkg.get('dependencies'):
                raise ValueError('Unexpected package identity/dependencies')
            # Production files are untouched; published development setup is unused.
            for key in ('scripts', 'devDependencies'):
                pkg.pop(key, None)
            (target / 'package.json').write_text(json.dumps(pkg, indent=2)+'\n')
            (target / 'probe.cjs').write_text(case['probe'])
    print(root)


if __name__ == '__main__':
    prepare(pathlib.Path(sys.argv[1]).resolve())
