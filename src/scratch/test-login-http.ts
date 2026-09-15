async function testHttpLogin() {
  console.log('Sending POST http://127.0.0.1:4000/api/auth/login...');
  try {
    const res = await fetch('http://127.0.0.1:4000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'superadmin@parallaxflow.com',
        password: 'SuperAdmin123!',
      }),
    });

    console.log('HTTP STATUS:', res.status);
    const data = await res.json();
    console.log('RESPONSE DATA:', data);
  } catch (err: any) {
    console.error('HTTP REQUEST FAILED:', err.message);
  }
}

testHttpLogin();
