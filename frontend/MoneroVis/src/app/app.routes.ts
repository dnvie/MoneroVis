import { Routes } from '@angular/router';

import { BlockComponent } from './components/block/block.component';
import { Blocks } from './components/blocks/blocks';
import { TransactionComponent } from './components/transaction/transaction';
import { Home } from './components/home/home';
import { PageNotFound } from './components/page-not-found/page-not-found';

export const routes: Routes = [
  {
    path: '',
    component: Home,
    title: 'Home · MoneroVis.com',
  },
  { path: 'block/:height', component: BlockComponent, title: 'Block · MoneroVis.com' },
  {
    path: 'tx/:hash',
    component: TransactionComponent,
    title: 'Tx · MoneroVis.com',
  },
  {
    path: 'blocks',
    component: Blocks,
    title: 'Blocks · MoneroVis.com',
  },
  { path: '**', component: PageNotFound, title: '404 · MoneroVis.com' },
];
