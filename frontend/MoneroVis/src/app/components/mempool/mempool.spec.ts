import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Mempool } from './mempool';

describe('Mempool', () => {
  let component: Mempool;
  let fixture: ComponentFixture<Mempool>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Mempool]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Mempool);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
