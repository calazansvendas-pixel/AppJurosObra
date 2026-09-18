// Sincroniza Firebase Auth -> Firestore ('usuarios'): cria o documento que falta
// para cada usuário "órfão" (existe no Auth, mas não tem doc em usuarios/{uid}).
//
// Uso:
//   set GOOGLE_APPLICATION_CREDENTIALS=C:\caminho\service-account.json
//   node scripts/sync-usuarios.js            (simulação: só lista os órfãos)
//   node scripts/sync-usuarios.js --apply    (grava os documentos faltantes)
//
// Órfãos são criados com perfil "Corretor" e status "pendente" (o administrador
// aprova depois). Documentos existentes nunca são alterados (usa create()).
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const PROJECT_ID = 'juros-obra-ea823';
const MASTER_ADMIN_UID = 'fcDrOzv6KxP6sEXfrbeOmYd6SIj1';
const MASTER_ADMIN_EMAIL = 'calazansvendas@gmail.com';
const apply = process.argv.includes('--apply');

if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
const auth = getAuth();
const db = getFirestore();

async function listarTodosUsuariosAuth() {
  const usuarios = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    usuarios.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return usuarios;
}

async function main() {
  const usuariosAuth = await listarTodosUsuariosAuth();
  const snap = await db.collection('usuarios').get();
  const uidsComDoc = new Set(snap.docs.map((d) => d.id));

  console.log(`Auth: ${usuariosAuth.length} usuários | Firestore 'usuarios': ${snap.size} documentos`);

  const orfaos = usuariosAuth.filter((u) => !uidsComDoc.has(u.uid));
  const ignorados = orfaos.filter(
    (u) => u.uid === MASTER_ADMIN_UID || (u.email || '').toLowerCase() === MASTER_ADMIN_EMAIL
  );
  const aCriar = orfaos.filter((u) => !ignorados.includes(u));

  ignorados.forEach((u) =>
    console.log(`- ignorado (Admin Mestre, o app cria o próprio doc no login): ${u.email} [${u.uid}]`)
  );

  if (aCriar.length === 0) {
    console.log('Nenhum usuário órfão para sincronizar.');
    return;
  }

  console.log(`\nÓrfãos encontrados (${aCriar.length}):`);
  aCriar.forEach((u) => console.log(`- ${u.email || '(sem e-mail)'} [${u.uid}]`));

  if (!apply) {
    console.log('\nSimulação: nada foi gravado. Rode com --apply para criar os documentos.');
    return;
  }

  let criados = 0;
  for (const u of aCriar) {
    try {
      await db.collection('usuarios').doc(u.uid).create({
        nome: u.displayName || (u.email ? u.email.split('@')[0] : ''),
        email: (u.email || '').toLowerCase(),
        role: 'corretor',
        perfil: 'Corretor',
        status: 'pendente',
        createdAt: FieldValue.serverTimestamp(),
        dataCriacao: new Date().toISOString(),
        origem: 'sync-usuarios',
      });
      criados++;
      console.log(`+ criado: ${u.email} [${u.uid}]`);
    } catch (err) {
      // code 6 = ALREADY_EXISTS (criado por outro processo entre a leitura e a escrita)
      console.error(`! falha em ${u.email} [${u.uid}]: ${err.message}`);
    }
  }
  console.log(`\nConcluído: ${criados}/${aCriar.length} documentos criados.`);
}

main().catch((err) => {
  console.error('Erro na sincronização:', err);
  process.exit(1);
});
