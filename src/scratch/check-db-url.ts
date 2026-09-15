import pkg from 'pg';
const { Client } = pkg;

const url = "postgresql://pf_test:rB_RVXzWZb2XDZdi3Fssc1SKt2iC9XDnRMVW5ltho-4@127.0.0.1:55432/parallax_flow_test?sslmode=disable";

async function check() {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    console.log('SUCCESS CONNECTING TO DOCKER CONTAINER ON PORT 55432:', url);
    const res = await client.query('SELECT current_user, current_database()');
    console.log('QUERY RESULT:', res.rows[0]);
    await client.end();
  } catch (err: any) {
    console.log('FAILED:', err.message);
  }
}

check();
