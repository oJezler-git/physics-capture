import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import type { PhysicsResult } from '../types';

export const exportCSV = (result: PhysicsResult): string => {
  const lines: string[] = [
    'ball_id,mass_kg,mass_uncertainty,v_before_mps,v_before_uncertainty,v_after_mps,v_after_uncertainty,p_before,p_before_uncertainty,p_after,p_after_uncertainty,ke_before,ke_before_uncertainty,ke_after,ke_after_uncertainty',
  ];

  for (const ball of result.balls) {
    lines.push(
      [
        ball.ballId,
        ball.mass_kg.value,
        ball.mass_kg.uncertainty,
        ball.v_before.value,
        ball.v_before.uncertainty,
        ball.v_after.value,
        ball.v_after.uncertainty,
        ball.p_before.value,
        ball.p_before.uncertainty,
        ball.p_after.value,
        ball.p_after.uncertainty,
        ball.ke_before.value,
        ball.ke_before.uncertainty,
        ball.ke_after.value,
        ball.ke_after.uncertainty,
      ]
        .map((value) => (typeof value === 'number' ? value.toFixed(4) : String(value)))
        .join(','),
    );
  }

  lines.push('');
  lines.push('metric,value,uncertainty');
  lines.push(
    `momentum_conserved_pct,${result.system.momentum_conserved_pct.value.toFixed(4)},${result.system.momentum_conserved_pct.uncertainty.toFixed(4)}`,
  );
  lines.push(
    `coeff_of_restitution,${result.system.coeff_of_restitution.value.toFixed(4)},${result.system.coeff_of_restitution.uncertainty.toFixed(4)}`,
  );
  lines.push(
    `collision_frame_idx,${result.system.collision_frame_idx.toFixed(0)},0.0000`,
  );

  return `${lines.join('\n')}\n`;
};

export const exportJSON = (result: PhysicsResult): string => JSON.stringify(result, null, 2);

export const exportPDF = async (container: HTMLElement, title = 'PhysicsCapture Results'): Promise<Blob> => {
  const canvas = await html2canvas(container, {
    scale: Math.max(2, window.devicePixelRatio || 1),
    backgroundColor: '#020617',
  });

  const imageData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({
    orientation: canvas.width > canvas.height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [canvas.width, canvas.height],
  });

  pdf.setFontSize(18);
  pdf.text(title, 24, 28);
  pdf.addImage(imageData, 'PNG', 0, 40, canvas.width, canvas.height - 40);

  return pdf.output('blob');
};

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
