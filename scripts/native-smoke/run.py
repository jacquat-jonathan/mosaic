#!/usr/bin/env python3
"""Run only a feature-gated smoke bundle, never an installed user's app."""
import argparse, json, os, pathlib, subprocess, tempfile, time, shutil, platform, struct, zlib

parser=argparse.ArgumentParser()
parser.add_argument('bundle', type=pathlib.Path)
parser.add_argument('--artifacts', type=pathlib.Path, default=pathlib.Path('target/native-smoke'))
args=parser.parse_args()
bundle=args.bundle.resolve()
identifier=subprocess.check_output(['/usr/bin/plutil','-extract','CFBundleIdentifier','raw','-o','-',str(bundle/'Contents/Info.plist')],text=True).strip()
if identifier != 'dev.jona.mosaic.native-smoke': raise SystemExit('Refusing to launch a non-smoke bundle')
artifacts=args.artifacts.resolve(); artifacts.mkdir(parents=True,exist_ok=True)
# Never leave a stale successful phase report after a failed rerun.
for name in ['first.json','restart.json','first.png','restart.png','environment.json']:
    (artifacts/name).unlink(missing_ok=True)
# mkdtemp location is checked again in the native host; no HOME override or user vault access.
with tempfile.TemporaryDirectory(prefix='mosaic-native-smoke-') as tmp:
    root=pathlib.Path(tmp).resolve()
    (root/'.native-smoke-fixture').touch()
    for name in ['Vault','settings','cache']: (root/name).mkdir()
    def chunk(kind, data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    (root/'Vault/pixel.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\xff\xff\xff'))+chunk(b'IEND',b''))
    # Valid one-page PDF, including a byte-accurate xref table.
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',b'<< /Length 0 >>\nstream\n\nendstream']
    pdf=b'%PDF-1.4\n'; offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(pdf));pdf+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
    xref=len(pdf);pdf+=b'xref\n0 5\n0000000000 65535 f \n'+b''.join(f'{x:010} 00000 n \n'.encode() for x in offsets[1:])+f'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    (root/'Vault/fixture.pdf').write_bytes(pdf)
    env={**os.environ,'MOSAIC_SMOKE_ROOT':str(root),'MOSAIC_SETTINGS_DIR':str(root/'settings'),'MOSAIC_CACHE_DIR':str(root/'cache')}
    env.pop('MOSAIC_VAULT',None)
    exe=bundle/'Contents/MacOS/mosaic-app'
    metadata={'platform':platform.platform(),'machine':platform.machine(),'bundle':str(bundle),'identifier':identifier,'screenshots':{}}
    try:
        for phase in ['first','restart']:
            with (artifacts/f'{phase}.log').open('wb') as log:
                process=subprocess.Popen([str(exe)],env={**env,'MOSAIC_SMOKE_PHASE':phase},stdout=log,stderr=subprocess.STDOUT)
                try:
                    deadline=time.monotonic()+120
                    report=root/f'{phase}.json'
                    result={}
                    while process.poll() is None and time.monotonic()<deadline:
                        if report.exists():
                            try: result=json.loads(report.read_text())
                            except json.JSONDecodeError: pass
                            if 'ok' in result: break
                        time.sleep(.2)
                    if report.exists(): shutil.copy2(report,artifacts/report.name)
                    if 'ok' not in result: raise RuntimeError(f'{phase}: native process exited or timed out; progress={result}; see log')
                    # Capture only our process window, never the desktop or other applications.
                    try:
                        window=subprocess.check_output(['swift',str(pathlib.Path(__file__).with_name('window.swift')),str(process.pid)],text=True,stderr=subprocess.STDOUT,timeout=30).strip()
                        subprocess.run(['/usr/sbin/screencapture','-x','-l',window,str(artifacts/f'{phase}.png')],check=True,timeout=15)
                        subprocess.check_output(['swift',str(pathlib.Path(__file__).with_name('image-check.swift')),str(artifacts/f'{phase}.png')],stderr=subprocess.STDOUT,timeout=30)
                        metadata['screenshots'][phase]='captured and nonblank'
                    except Exception as error:
                        detail=getattr(error,'output',None)
                        metadata['screenshots'][phase]=str(error)+(f': {detail}' if detail else '')
                    if not result.get('ok'): raise RuntimeError(f'{phase}: {result}')
                finally:
                    process.terminate()
                    try: process.wait(timeout=10)
                    except subprocess.TimeoutExpired: process.kill();process.wait()
        assert (root/'Vault/Smoke.md').read_text()=='# External MCP edit\n'
    finally: (artifacts/'environment.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(f'Native smoke passed; evidence: {artifacts}')
