import pkg from 'pg';
const { Client } = pkg;

const passwords = [
  "postgres",
  "password",
  "123456",
  "12345",
  "admin",
  "root",
  "pf_test_local_password",
  "SuperAdmin123!",
  "rB_RVXzWZb2XDZdi3Fssc1SKt2iC9XDnRMVW5ltho-4",
  "",
];

async function check() {
  for (const pass of passwords) {
    const url = `postgresql://postgres:${encodeURIComponent(pass)}@127.0.0.1:5432/postgres?sslmode=disable`;
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      console.log('SUCCESSFUL PASSWORD FOR postgres USER ON PORT 5432:', pass ? pass : '(empty)');
      const res = await client.query('SELECT current_user, current_database()');
      console.log('QUERY RESULT:', res.rows[0]);
      await client.end();
      return pass;
    } catch (err: any) {
      // ignore
    }
  }
  console.log('NO MATCHING PASSWORD FOUND FOR NATIVE POSTGRES ON 5432.');
}

check();
