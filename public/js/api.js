const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  localStorage.setItem('token', token);
}

function clearToken() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

function setUser(user) {
  localStorage.setItem('user', JSON.stringify(user));
}

function getUser() {
  const u = localStorage.getItem('user');
  return u ? JSON.parse(u) : null;
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(API_BASE + path, {
    ...options,
    headers,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

const api = {
  auth: {
    register: (username, password) => request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
    login: (username, password) => request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
    me: () => request('/auth/me'),
    logout: () => { clearToken(); },
  },
  seats: {
    list: () => request('/seats'),
    get: (id) => request(`/seats/${id}`),
    create: (data) => request('/seats', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/seats/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/seats/${id}`, { method: 'DELETE' }),
    availability: (date, hour) => request(`/seats/availability/${date}/${hour}`),
  },
  bookings: {
    list: () => request('/bookings'),
    create: (seatId, bookingDate, hourSlot) => request('/bookings', {
      method: 'POST',
      body: JSON.stringify({ seatId, bookingDate, hourSlot }),
    }),
    checkin: (id) => request(`/bookings/${id}/checkin`, { method: 'POST' }),
    checkout: (id) => request(`/bookings/${id}/checkout`, { method: 'POST' }),
    cancel: (id) => request(`/bookings/${id}/cancel`, { method: 'POST' }),
  },
  admin: {
    bookings: (startDate, endDate) => {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      return request(`/admin/bookings?${params.toString()}`);
    },
    utilization: (startDate, endDate) => {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      return request(`/admin/stats/utilization?${params.toString()}`);
    },
    users: () => request('/admin/users'),
    noShows: () => request('/admin/no-shows'),
  },
  getToken, setToken, clearToken, setUser, getUser,
};
