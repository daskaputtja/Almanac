/**
 * Account recovery from the command line, for when someone is locked out.
 *
 *   docker exec -it almanac almanac-cli users
 *   docker exec -it almanac almanac-cli reset-2fa <username>
 *   docker exec -it almanac almanac-cli reset-password <username>
 *
 * Outside Docker: npm run cli -- <command>
 */
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AuthError, AuthService } from './auth/service.js';
import { openDatabase } from './db/database.js';

const [command, username] = process.argv.slice(2);
const dataDir = process.env.DATA_DIR ?? 'data';
const mock = ['1', 'true', 'yes', 'on'].includes((process.env.SILO_MOCK ?? '').toLowerCase());
const db = openDatabase(join(dataDir, mock ? 'almanac-demo.db' : 'almanac.db'));
const auth = new AuthService(db);

/** Read a line without echoing it, for passwords. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    output._writeToOutput = (s: string) => {
      if (!muted || s.includes('\n')) process.stdout.write(muted ? '\n' : s);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<number> {
  switch (command) {
    case 'users': {
      const users = auth.listUsernames();
      if (!users.length) console.log('No accounts yet.');
      for (const u of users) console.log(`${u.username}${u.totpEnabled ? '' : '  (2FA not set up)'}`);
      return 0;
    }
    case 'reset-2fa': {
      if (!username) break;
      auth.resetTwoFactor(username);
      console.log(`Two-factor authentication for ${username} is reset and all their sessions are signed out.`);
      console.log('They will set up 2FA again the next time they sign in.');
      return 0;
    }
    case 'reset-password': {
      if (!username) break;
      const password = process.env.NEW_PASSWORD ?? (await askHidden(`New password for ${username}: `));
      if (!process.env.NEW_PASSWORD) {
        const again = await askHidden('Type it again: ');
        if (again !== password) {
          console.error('The passwords didn’t match.');
          return 1;
        }
      }
      await auth.resetPassword(username, password);
      console.log(`Password for ${username} changed and all their sessions are signed out. 2FA is unchanged.`);
      return 0;
    }
  }
  console.log('Usage:');
  console.log('  almanac-cli users                      List accounts');
  console.log('  almanac-cli reset-2fa <username>       Turn off 2FA so it can be set up again');
  console.log('  almanac-cli reset-password <username>  Set a new password');
  return command ? 1 : 0;
}

main()
  .then((code) => {
    db.close();
    process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof AuthError ? err.message : err);
    db.close();
    process.exit(1);
  });
