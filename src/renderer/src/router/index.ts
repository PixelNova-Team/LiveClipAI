import { createRouter, createWebHistory } from 'vue-router'

const Dashboard = () => import('@/views/Dashboard.vue')
const TaskDetail = () => import('@/views/TaskDetail.vue')
const LiveTaskList = () => import('@/views/LiveTaskList.vue')
const ClipManager = () => import('@/views/ClipManager.vue')
const NotificationList = () => import('@/views/NotificationList.vue')
const Settings = () => import('@/views/Settings.vue')

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'Dashboard', component: Dashboard },
  { path: '/live', name: 'LiveTaskList', component: LiveTaskList },
  { path: '/live/new', name: 'LiveNew', component: LiveTaskList, props: { autoNew: true } },
  { path: '/live/:id', name: 'LiveTaskDetail', component: TaskDetail, props: () => ({ taskType: 'live' }) },
  { path: '/clips', name: 'Clips', component: ClipManager },
  { path: '/notifications', name: 'Notifications', component: NotificationList },
  { path: '/settings', name: 'Settings', component: Settings },
  // Backward compatibility
  { path: '/publish', redirect: '/clips' },
  { path: '/tasks', redirect: '/live' },
  { path: '/tasks/:id', redirect: (to: any) => `/live/${to.params.id}` },
  { path: '/video', redirect: '/live' },
  { path: '/video/:id', redirect: (to: any) => `/live/${to.params.id}` },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
