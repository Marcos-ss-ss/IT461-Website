const API = "https://wds-drycleaning-group-8.onrender.com";

document.getElementById("loginForm").addEventListener("submit", function (e) {
  e.preventDefault();

  const identifier = document.getElementById("loginInput").value;
  const password = document.getElementById("password").value;
  const messageEl = document.getElementById("loginMessage");

  messageEl.textContent = "Logging in...";

  fetch(`${API}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password })
  })
    .then(res => res.json())
    .then(data => {
      if (data.token) {
        localStorage.setItem("token", data.token);
        localStorage.setItem("role", data.role);
        localStorage.setItem("first_name", data.first_name);
        localStorage.setItem("last_name", data.last_name);
        localStorage.setItem("email", data.email || identifier); // <-- THIS FIX

        if (data.role === "worker") {
          window.location.href = "employee.html";
        } else {
          window.location.href = "OrderPage.html";
        }
      } else {
        messageEl.textContent = "Invalid credentials. Please try again.";
      }
    })
    .catch(() => {
      messageEl.textContent = "Server error. Please try again.";
    });
});