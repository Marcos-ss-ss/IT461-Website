const API = "https://wds-drycleaning-group-8.onrender.com";

document.getElementById("createAccountForm").addEventListener("submit", function (e) {
  e.preventDefault();

  const first_name = document.getElementById("firstName").value;
  const last_name = document.getElementById("lastName").value;
  const phone = document.getElementById("phone").value;
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  const messageEl = document.getElementById("accountMessage");

  messageEl.textContent = "Creating account...";

  fetch(`${API}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ first_name, last_name, phone, email, password })
  })
    .then(res => res.json())
    .then(data => {
      if (data.userId) {
        messageEl.textContent = "Account created! Redirecting to login...";
        setTimeout(() => {
          window.location.href = "login.html";
        }, 2000);
      } else {
        messageEl.textContent = data.error || "Account creation failed.";
      }
    })
    .catch(() => {
      messageEl.textContent = "Server error. Please try again.";
    });
});
