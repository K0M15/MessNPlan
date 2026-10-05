import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import AppLayout from '@/components/AppLayout.vue';
import AdminUsersView from '@/views/AdminUsersView.vue';
import LoginView from '@/views/LoginView.vue';
import NotFoundView from '@/views/NotFoundView.vue';
import ProjectView from '@/views/ProjectView.vue';
import ProjectsView from '@/views/ProjectsView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', name: 'projects', component: ProjectsView },
        { path: 'projects/:id', name: 'project', component: ProjectView, props: true },
        {
          path: 'admin/users',
          name: 'admin-users',
          component: AdminUsersView,
          meta: { requiresAdmin: true },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.initialized) await auth.bootstrap();

  const isPublic = to.meta.public === true;
  if (!isPublic && !auth.user) {
    return { name: 'login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  }
  if (isPublic && auth.user) {
    return { name: 'projects' };
  }
  if (to.meta.requiresAdmin === true && auth.user?.role !== 'admin') {
    return { name: 'projects' };
  }
  return true;
});
