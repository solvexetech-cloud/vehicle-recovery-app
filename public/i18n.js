const translations = {
  en: {
    "app.title": "Vehicle Recovery",
    "nav.logout": "Logout",
    "nav.home": "Home", "nav.services": "Services", "nav.activity": "Activity", "nav.account": "Account",
    "nav.dashboard": "Dashboard", "nav.fleet": "Fleet", "nav.history": "History", "nav.profile": "Profile", "nav.users": "Users", "nav.settings": "Settings", "nav.overview": "Overview",
    "home.new_recovery": "🚨 New Recovery",
    "home.pickup": "Pickup Location", "home.destination": "Destination", "home.vehicle_reg": "Your Vehicle Registration",
    "home.get_estimate": "Get Estimate & Book",
    "home.your_vehicles": "🚗 Your Vehicles", "home.add_vehicle": "Add Vehicle",
    "home.your_bookings": "📋 Your Bookings",
    "driver.status": "Status", "driver.offline": "Offline", "driver.online": "Online", "driver.go_online": "Go Online", "driver.go_offline": "Go Offline",
    "driver.summary": "💰 Today's Summary", "driver.trips": "Trips", "driver.earnings": "Earnings",
    "agency.overview": "📊 Today's Overview", "agency.revenue": "Revenue", "agency.active_trips": "Active Trips",
    "agency.quick_actions": "⚡ Quick Actions", "agency.add_driver": "+ Add Driver", "agency.add_vehicle": "+ Add Vehicle",
    "agency.live_bookings": "🚨 Live Bookings",
    "admin.analytics": "📈 Platform Analytics", "admin.total_users": "Total Users", "admin.active_drivers": "Active Drivers",
    "admin.tickets": "🎫 Support Tickets", "admin.resolve": "Resolve"
  },
  ar: {
    "app.title": "استرداد المركبات",
    "nav.logout": "تسجيل خروج",
    "nav.home": "الرئيسية", "nav.services": "الخدمات", "nav.activity": "النشاط", "nav.account": "الحساب",
    "nav.dashboard": "لوحة التحكم", "nav.fleet": "الأسطول", "nav.history": "السجل", "nav.profile": "الملف الشخصي", "nav.users": "المستخدمين", "nav.settings": "الإعدادات", "nav.overview": "نظرة عامة",
    "home.new_recovery": "🚨 استرداد جديد",
    "home.pickup": "موقع الالتقاط", "home.destination": "الوجهة", "home.vehicle_reg": "تسجيل مركبتك",
    "home.get_estimate": "احصل على تقدير واحجز",
    "home.your_vehicles": "🚗 مركباتك", "home.add_vehicle": "إضافة مركبة",
    "home.your_bookings": "📋 حجوزاتك",
    "driver.status": "الحالة", "driver.offline": "غير متصل", "driver.online": "متصل", "driver.go_online": "اتصل بالإنترنت", "driver.go_offline": "قطع الاتصال",
    "driver.summary": "💰 ملخص اليوم", "driver.trips": "رحلات", "driver.earnings": "الأرباح",
    "agency.overview": "📊 نظرة عامة اليوم", "agency.revenue": "الإيرادات", "agency.active_trips": "الرحلات النشطة",
    "agency.quick_actions": "⚡ إجراءات سريعة", "agency.add_driver": "+ إضافة سائق", "agency.add_vehicle": "+ إضافة مركبة",
    "agency.live_bookings": "🚨 الحجوزات المباشرة",
    "admin.analytics": "📈 تحليلات المنصة", "admin.total_users": "إجمالي المستخدمين", "admin.active_drivers": "السائقين النشطين",
    "admin.tickets": "🎫 تذاكر الدعم", "admin.resolve": "حل"
  }
};

let currentLang = localStorage.getItem('lang') || 'en';

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (translations[currentLang][key]) {
      el.textContent = translations[currentLang][key];
    }
  });

  // RTL / LTR ക്രമീകരണം
  if (currentLang === 'ar') {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'ar');
  } else {
    document.documentElement.setAttribute('dir', 'ltr');
    document.documentElement.setAttribute('lang', 'en');
  }

  // ലാംഗ്വേജ് ടോഗിൾ ബട്ടണിലെ ടെക്സ്റ്റ്
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) langBtn.textContent = currentLang === 'en' ? 'العربية' : 'English';
}

document.addEventListener('DOMContentLoaded', () => {
  applyTranslations();
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.addEventListener('click', () => {
      currentLang = currentLang === 'en' ? 'ar' : 'en';
      localStorage.setItem('lang', currentLang);
      applyTranslations();
    });
  }
});
