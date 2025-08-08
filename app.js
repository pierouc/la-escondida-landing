(function(){
  const byId = (id) => document.getElementById(id);
  const form = byId('reserveForm');
  const toast = byId('toast');
  const submitBtn = byId('submitBtn');
  const yearSpan = byId('year');
  if (yearSpan) yearSpan.textContent = new Date().getFullYear();

  // Prefill fecha y hora con próximos 90 minutos redondeado a media hora
  const dateInput = byId('date');
  const timeInput = byId('time');
  if (dateInput && timeInput) {
    const now = new Date();
    const next = new Date(now.getTime() + 90 * 60000);
    next.setMinutes(next.getMinutes() + (30 - next.getMinutes() % 30) % 30, 0, 0);
    dateInput.value = next.toISOString().slice(0,10);
    timeInput.value = next.toTimeString().slice(0,5);
    dateInput.min = new Date().toISOString().slice(0,10);
  }

  function showToast(message, type='success') {
    toast.className = `toast show ${type}`;
    toast.textContent = message;
    setTimeout(() => { toast.classList.remove('show'); }, 4200);
  }

  function setError(id, msg='') {
    const el = document.querySelector(`[data-error-for="${id}"]`);
    if (el) el.textContent = msg;
  }

  function validate() {
    let ok = true;
    const name = byId('name').value.trim();
    const phone = byId('phone').value.trim();
    const email = byId('email').value.trim();
    const people = Number(byId('people').value);
    const date = byId('date').value;
    const time = byId('time').value;

    setError('name', ''); setError('phone',''); setError('email','');
    setError('people',''); setError('date',''); setError('time','');

    if (name.length < 2) { setError('name', 'Ingresa un nombre válido.'); ok=false; }
    if (phone.length < 6) { setError('phone','Ingresa un teléfono válido.'); ok=false; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('email','Email inválido.'); ok=false; }
    if (!Number.isFinite(people) || people < 1 || people > 20) { setError('people','Entre 1 y 20.'); ok=false; }
    if (!date) { setError('date','Selecciona una fecha.'); ok=false; }
    if (!time) { setError('time','Selecciona una hora.'); ok=false; }

    const dt = date && time ? new Date(`${date}T${time}:00`) : null;
    if (dt && dt.getTime() <= Date.now()) { setError('time','Debe ser una hora futura.'); ok=false; }

    return ok;
  }

  async function submitReservation(e) {
    e.preventDefault();
    if (!validate()) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando…';

    const payload = {
      name: byId('name').value.trim(),
      phone: byId('phone').value.trim(),
      email: byId('email').value.trim(),
      people: Number(byId('people').value),
      date: byId('date').value,
      time: byId('time').value,
      notes: byId('notes').value.trim(),
    };

    try {
      const res = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'No se pudo enviar la reserva.');
      }
      form.reset();
      // Recolocar fecha y hora
      if (dateInput && timeInput) {
        const now = new Date();
        const next = new Date(now.getTime() + 90 * 60000);
        next.setMinutes(next.getMinutes() + (30 - next.getMinutes() % 30) % 30, 0, 0);
        dateInput.value = next.toISOString().slice(0,10);
        timeInput.value = next.toTimeString().slice(0,5);
      }
      showToast(`Reserva recibida. Código: ${data.code}`, 'success');
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Error al enviar la reserva.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Enviar reserva';
    }
  }

  form?.addEventListener('submit', submitReservation);
})();