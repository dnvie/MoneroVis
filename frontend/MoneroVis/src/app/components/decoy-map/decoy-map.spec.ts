import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DecoyMap } from './decoy-map';

describe('DecoyMap', () => {
  let component: DecoyMap;
  let fixture: ComponentFixture<DecoyMap>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DecoyMap]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DecoyMap);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
