import sharp from 'sharp';

const escapeXml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const clean=(value,max)=>String(value??'').trim().slice(0,max);
const wrap=(value,limit)=>{const chars=Array.from(value||'');const lines=[];while(chars.length)lines.push(chars.splice(0,limit).join(''));return lines.length?lines:[''];};
export async function generateWorkTemplate(data={}){
 const title=clean(data.title||'업무 진행표',60);
 const reason=clean(data.reason,150);
 const schedule=clean(data.schedule,120);
 const owner=clean(data.owner,70);
 const notes=clean(data.notes,350);
 if(!reason&&!schedule&&!owner&&!notes)throw new Error('내용을 한 항목 이상 입력해 주세요.');
 const W=1200,H=1600,margin=82,inner=W-2*margin;
 const t=(x,y,text,size=25,extra='')=>'<text x="'+x+'" y="'+y+'" font-family="Noto Sans CJK KR, sans-serif" font-size="'+size+'" fill="#1f2937" '+extra+'>'+escapeXml(text)+'</text>';
 const line=(x1,y1,x2,y2)=>'<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="#cbd5e1" stroke-width="1.5"/>';
 const rows=[
   ['진행 사유',reason],['진행 일정',schedule],['담당자',owner],['비고',notes]
 ];
 let fields='';
 rows.forEach(([label,value],i)=>{
   const top=270+i*120;
   fields+='<rect x="'+margin+'" y="'+top+'" width="'+inner+'" height="120" fill="'+(i%2?'#f8fafc':'#ffffff')+'"/>';
   fields+=t(margin+24,top+45,label,23,'font-weight="700"');
   fields+=line(margin+175,top,margin+175,top+120);
   wrap(value,40).slice(0,3).forEach((part,j)=>{fields+=t(margin+200,top+42+j*28,part,23)});
   fields+=line(margin,top+120,margin+inner,top+120);
 });
 let grid='';
 const starts=[margin,margin+76,margin+360,margin+605,margin+825,margin+inner];
 grid+='<rect x="'+margin+'" y="836" width="'+inner+'" height="48" fill="#e9eef6"/>';
 ['번호','업무 내용','진행 상태','예정일','확인'].forEach((name,i)=>{grid+=t((starts[i]+starts[i+1])/2,868,name,19,'font-weight="700" text-anchor="middle"')});
 for(let j=0;j<=8;j++)grid+=line(margin,884+j*64,margin+inner,884+j*64);
 starts.forEach(x=>{grid+=line(x,836,x,884+8*64)});
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'"><rect width="'+W+'" height="'+H+'" fill="#ffffff"/>'+
  '<rect x="0" y="0" width="'+W+'" height="14" fill="#385783"/>'+
  t(margin,86,'새로 작성한 업무 문서',17,'fill="#64748b"')+
  t(margin,160,title,45,'font-weight="700"')+
  t(margin,204,'입력한 정보를 바탕으로 새로 생성한 양식입니다.',19,'fill="#64748b"')+
  '<rect x="'+margin+'" y="270" width="'+inner+'" height="480" fill="none" stroke="#cbd5e1" stroke-width="1.5"/>'+
  fields+t(margin,806,'업무 진행 내역',26,'font-weight="700"')+grid+
  line(margin,1480,margin+inner,1480)+
  t(margin,1518,'새로 작성한 문서 · 기존 이미지의 수정본이 아닙니다.',17,'fill="#64748b"')+
  '</svg>';
 return sharp(Buffer.from(svg)).png().toBuffer();
}
