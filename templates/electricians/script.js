document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('contact-form');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (typeof gtag === 'function') {
      gtag('event', 'form_submit', { event_category: 'engagement', event_label: 'contact_form' });
    }

    var name = encodeURIComponent(form.name.value);
    var phone = encodeURIComponent(form.phone.value);
    var message = encodeURIComponent(form.message.value);
    var to = '{{EMAIL}}';
    var subject = encodeURIComponent('Website inquiry from ' + form.name.value);
    var body = 'Name: ' + name + '%0APhone: ' + phone + '%0A%0A' + message;

    window.location.href = 'mailto:' + to + '?subject=' + subject + '&body=' + body;
  });
});
