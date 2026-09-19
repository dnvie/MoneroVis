import { Component, inject } from '@angular/core';
import { ModalService } from '../../service/modal.service';

@Component({
  selector: 'app-footer',
  imports: [],
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
})
export class Footer {
  public modalService = inject(ModalService);

  openDisclaimer() {
    this.modalService.open('disclaimer');
  }
}
