// Read-only support inbox. The dedicated credential stays outside Git.
import {readFile,stat} from 'node:fs/promises';
const file=new URL('../../.local/diagnostics-reader-token',import.meta.url);
try {
  const info=await stat(file);
  if(info.mode & 0o077) throw new Error('Local diagnostics credential must have mode 0600');
  const token=(await readFile(file,'utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(token)) throw new Error('Local diagnostics credential is missing or invalid');
  const response=await fetch('https://boxxie-share-server.ricky-kundi.workers.dev/admin/diagnostics',{
    headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('Diagnostics inbox returned HTTP '+response.status);
  process.stdout.write(JSON.stringify(await response.json(),null,2)+'\n');
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}
