async function upload() {
  const file = document.getElementById("file").files[0];

  if (!file) {
    alert("Select file");
    return;
  }

  const reader = new FileReader();

  reader.onload = async function () {

    const base64 = reader.result;

    const res = await fetch(BASE + "/api/image-store", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        uid: uid.value,
        promptId: pid.value,
        imageBase64: base64
      })
    });

    const data = await res.json();

    if (data.success) {
      alert("Uploaded ✅");
    } else {
      alert("Failed ❌");
      console.log(data);
    }
  };

  reader.readAsDataURL(file);
}
