import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
    title: 'Up Next · TV Time',
  },
  {
    path: 'shows',
    loadComponent: () => import('./features/shows/shows').then((m) => m.Shows),
    title: 'Shows · TV Time',
  },
  {
    path: 'shows/:uuid',
    loadComponent: () => import('./features/show-detail/show-detail').then((m) => m.ShowDetail),
    title: 'Show · TV Time',
  },
  {
    path: 'movies',
    loadComponent: () => import('./features/movies/movies').then((m) => m.Movies),
    title: 'Movies · TV Time',
  },
  {
    path: 'movies/:uuid',
    loadComponent: () => import('./features/movie-detail/movie-detail').then((m) => m.MovieDetail),
    title: 'Movie · TV Time',
  },
  {
    path: 'lists',
    loadComponent: () => import('./features/lists/lists').then((m) => m.Lists),
    title: 'Lists · TV Time',
  },
  {
    path: 'profile',
    loadComponent: () => import('./features/profile/profile').then((m) => m.Profile),
    title: 'Profile · TV Time',
  },
  {
    // Someone else's published profile, addressed by the gist that holds it.
    path: 'u/:id',
    loadComponent: () =>
      import('./features/profile/public-profile').then((m) => m.PublicProfilePage),
    title: 'Profile · TV Time',
  },
  {
    // Target of a device-linking QR code; the payload rides in the fragment.
    path: 'link',
    loadComponent: () => import('./features/link/link').then((m) => m.Link),
    title: 'Link a device · TV Time',
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then((m) => m.Settings),
    title: 'Settings · TV Time',
  },
  { path: '**', redirectTo: '' },
];
